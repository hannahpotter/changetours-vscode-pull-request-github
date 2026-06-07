/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { GitChangeType, InMemFileChange } from '../../common/file';
import { CodeTourEditorProvider } from '../../github/codeTourEditorProvider';
import {
	CodeTourDocument,
	editContentFingerprint,
	ExcludedHunkMarker,
	findMarkersMatchingHunk,
	findTourHunksMatchingMarker,
	HighlightRange,
	HunkReference,
	isExactRangeMarker,
	isExcluded,
	isGlob,
	parseCodeTourMarkdown,
	parseTourExclusions,
	serializeCodeTourMarkdown,
	TourGroupNode,
	TourHunkNode,
	TourNode,
	TourTextNode,
} from '../../github/codeTourMarkdown';
import { appendNodeToGroupEnd, extractNodeById, insertNodeRelative } from '../../github/codeTourTreeHelpers';
import { PullRequestModel } from '../../github/pullRequestModel';
import { detectRateLimit, formatRateLimitMessage, recordObservedRateLimit } from '../../github/rateLimitError';
import { RepositoriesManager } from '../../github/repositoriesManager';

/* ----- Shared types --------------------------------------- */

interface NodeAnchor {
	after?: string;
	before?: string;
	endOfGroup?: string;
	endOfDocument?: boolean;
}

interface MutationContext {
	doc: CodeTourDocument;
}

/* ----- Helpers -------------------------------------------- */

function getActiveTourDocument(): vscode.TextDocument {
	const document = CodeTourEditorProvider.activeDocumentTracker;
	if (!document) {
		throw new Error('No Change Tour editor is currently active. Open a .changetour.md file and focus its editor before using assistant tools.');
	}
	return document;
}

/**
 * Run a GitHub-API call and rewrite recognized rate-limit failures into a
 * human-readable error before re-throwing. The thrown message is what the
 * chat tool-error UI renders verbatim - replacing the cryptic Octokit
 * "Request failed with status code 403" with "GitHub API rate limit hit.
 * Resets at 3:42 PM (in 12 min). Retry after the reset time."
 *
 * Non-rate-limit errors fall through untouched so existing UX paths
 * (auth dialogs, "Could not resolve pull request", etc.) are preserved.
 */
async function withRateLimitGuard<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (e) {
		const info = detectRateLimit(e);
		if (info) {
			recordObservedRateLimit(info);
			throw new Error(`${formatRateLimitMessage(info)} Retry after the reset time.`);
		}
		throw e;
	}
}

/**
 * Cache `getFileChangesInfo()` results across LM tool invocations within a
 * single chat turn. A typical `/generate` or `/improve` run calls
 * `changeTour_getAvailablePRHunks`, `changeTour_getDriftReport`, and
 * `changeTour_addHunkToTour` multiple times in quick succession - each one
 * currently triggers a fresh `compareCommits` REST call, even though the PR
 * diff hasn't changed in the seconds between invocations. The TTL cache here
 * makes the second through Nth call free.
 *
 * Keyed by PR identity (`<owner>/<repo>#<number>`) so concurrent tours
 * against different PRs don't collide. TTL is short on purpose: chat turns
 * typically complete within a few tens of seconds, and we want the next
 * turn (e.g. after the user manually adds a hunk and asks for another
 * /improve) to see fresh data. The PullRequestModel layer additionally keeps
 * its own per-instance cache, but that one is bypassed by
 * `getFileChangesInfo()` which clears `_fileChanges` on every call.
 */
interface FileChangesCacheEntry {
	at: number;
	files: Awaited<ReturnType<PullRequestModel['getFileChangesInfo']>>;
}
const FILE_CHANGES_CACHE_TTL_MS = 30 * 1000;
const _fileChangesCache = new Map<string, FileChangesCacheEntry>();
function fileChangesCacheKey(prOwner: string, prRepo: string, prNumber: number): string {
	return `${prOwner.toLowerCase()}/${prRepo.toLowerCase()}#${prNumber}`;
}
async function getCachedFileChangesInfo(
	prModel: PullRequestModel,
	prOwner: string,
	prRepo: string,
	prNumber: number,
): Promise<FileChangesCacheEntry['files']> {
	const key = fileChangesCacheKey(prOwner, prRepo, prNumber);
	const cached = _fileChangesCache.get(key);
	if (cached && Date.now() - cached.at < FILE_CHANGES_CACHE_TTL_MS) {
		return cached.files;
	}
	const fresh = await withRateLimitGuard(() => prModel.getFileChangesInfo());
	_fileChangesCache.set(key, { at: Date.now(), files: fresh });
	return fresh;
}

let _localIdCounter = 0;
function newLocalId(): string {
	return `assistant-${Date.now()}-${_localIdCounter++}`;
}

/**
 * Resolves the pull request that the active Change Tour is bound to via its
 * frontmatter (prNumber/prOwner/prRepo). The assistant tools rely on this
 * to look up real hunk content rather than trusting the LLM to invent it.
 */
async function getTourPRContext(reposManager: RepositoriesManager): Promise<{ doc: CodeTourDocument; rawText: string; prOwner: string; prRepo: string; prNumber: number; folderManager: NonNullable<ReturnType<RepositoriesManager['getManagerForRepository']>> }> {
	const document = getActiveTourDocument();
	const rawText = document.getText();
	const doc = parseCodeTourMarkdown(rawText);
	if (!doc.prOwner || !doc.prRepo || doc.prNumber === undefined) {
		throw new Error('The active Change Tour is not bound to a pull request. Create the tour via the "Pull Request: New Change Tour" command so it includes the required frontmatter (prNumber, prOwner, prRepo).');
	}
	const folderManager = reposManager.getManagerForRepository(doc.prOwner, doc.prRepo);
	if (!folderManager) {
		throw new Error(`No folder manager found for ${doc.prOwner}/${doc.prRepo}. Make sure the repository is open in the workspace.`);
	}
	return { doc, rawText, prOwner: doc.prOwner, prRepo: doc.prRepo, prNumber: doc.prNumber, folderManager };
}

/**
 * Find a real hunk in the active PR that matches `file` + `startLine-endLine`
 * (on the new side) and build a fully-populated HunkReference. The ref, patch
 * and previousFile come from the PR model - the LLM never invents them.
 */
async function resolveHunkInActivePR(
	reposManager: RepositoriesManager,
	file: string,
	startLine: number,
	endLine: number,
): Promise<HunkReference> {
	const { folderManager, prOwner, prRepo, prNumber } = await getTourPRContext(reposManager);
	// useCache: true + getCachedFileChangesInfo: a /generate run typically
	// calls this tool 5-10 times in a few seconds. Without caching we'd
	// refetch the entire PR diff every time.
	const prModel = await withRateLimitGuard(() => folderManager.resolvePullRequest(prOwner, prRepo, prNumber, true));
	if (!prModel) {
		throw new Error(`Could not resolve pull request #${prNumber} for ${prOwner}/${prRepo}.`);
	}
	const changes = await getCachedFileChangesInfo(prModel, prOwner, prRepo, prNumber);
	const fileChange = changes.find(c => c.fileName === file);
	if (!fileChange) {
		const available = changes.map(c => c.fileName).slice(0, 12).join(', ');
		throw new Error(`File "${file}" was not changed in pull request #${prNumber}. Available files include: ${available}`);
	}
	if (!(fileChange instanceof InMemFileChange) || !fileChange.diffHunks?.length) {
		throw new Error(`File "${file}" has no inline diff content (it may be binary or too large). Skip this file in the tour.`);
	}
	const matched = fileChange.diffHunks.find(h =>
		h.newLineNumber === startLine && (h.newLineNumber + Math.max(h.newLength, 1) - 1) === endLine,
	);
	if (!matched) {
		const available = fileChange.diffHunks
			.map(h => `${h.newLineNumber}-${h.newLineNumber + Math.max(h.newLength, 1) - 1}`)
			.join(', ');
		throw new Error(`No hunk in "${file}" matches new-side lines ${startLine}-${endLine}. Use one of: ${available} (call changeTour_getAvailablePRHunks to see the exact ranges).`);
	}
	// Reconstruct the raw patch text from the parsed diff lines. The first
	// diffLine is the `@@ -A,B +C,D @@` header (Control type).
	const patch = matched.diffLines.map(l => l.raw).join('\n');
	return {
		file,
		startLine,
		endLine,
		patch,
		previousFile: fileChange.previousFileName,
		baseBlob: fileChange.blobSha,
	};
}

/**
 * Read the current document, parse it, run a mutator, serialize, and apply
 * the edit. This single helper is the only path through which write tools
 * mutate the open document - gives consistent undo/redo + change events.
 */
async function applyMutation(mutate: (ctx: MutationContext) => void): Promise<{ doc: CodeTourDocument }> {
	const document = getActiveTourDocument();
	const doc = parseCodeTourMarkdown(document.getText());
	mutate({ doc });
	const newText = serializeCodeTourMarkdown(doc);
	const edit = new vscode.WorkspaceEdit();
	edit.replace(
		document.uri,
		new vscode.Range(0, 0, document.lineCount, 0),
		newText,
	);
	await vscode.workspace.applyEdit(edit);
	return { doc };
}

/**
 * Insert a node into the document at the position described by `anchor`.
 * Tolerant of a missing anchor: models occasionally drop the field from the
 * tool call even though the schema marks it required. In that case we fall
 * back to appending at the end of the document, which is the same behavior
 * the explicit `{ endOfDocument: true }` anchor produces.
 */
function insertAt(doc: CodeTourDocument, anchor: NodeAnchor | undefined, node: TourNode): boolean {
	if (!anchor || anchor.endOfDocument) {
		doc.children.push(node);
		return true;
	}
	if (anchor.endOfGroup) {
		const res = appendNodeToGroupEnd<TourNode>(doc.children, anchor.endOfGroup, node);
		if (res.inserted) {
			doc.children = res.nodes;
			return true;
		}
		return false;
	}
	if (anchor.after) {
		const res = insertNodeRelative<TourNode>(doc.children, anchor.after, node, 'after');
		if (res.inserted) {
			doc.children = res.nodes;
			return true;
		}
		return false;
	}
	if (anchor.before) {
		const res = insertNodeRelative<TourNode>(doc.children, anchor.before, node, 'before');
		if (res.inserted) {
			doc.children = res.nodes;
			return true;
		}
		return false;
	}
	// No anchor supplied → fall back to appending at the document end.
	doc.children.push(node);
	return true;
}

const NODE_ANCHOR_SCHEMA = {
	type: 'object',
	description: 'Where to insert the node. Provide exactly ONE of these fields.',
	properties: {
		after: { type: 'string', description: 'ID of the existing node to insert immediately after.' },
		before: { type: 'string', description: 'ID of the existing node to insert immediately before.' },
		endOfGroup: { type: 'string', description: 'ID of a group; the new node is appended as the last child of that group.' },
		endOfDocument: { type: 'boolean', description: 'If true, append at the end of the document.' },
	},
};

/* ----- Read tools ----------------------------------------- */

type GetCurrentTourParams = Record<string, never>;

class GetCurrentTourTool implements vscode.LanguageModelTool<GetCurrentTourParams> {
	static readonly toolId = 'changeTour_getCurrentTour';

	async prepareInvocation(): Promise<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: vscode.l10n.t('Reading current Change Tour'),
			pastTenseMessage: vscode.l10n.t('Read current Change Tour'),
		};
	}

	async invoke(): Promise<vscode.LanguageModelToolResult> {
		const document = getActiveTourDocument();
		const doc = parseCodeTourMarkdown(document.getText());
		// Trim hunk patch bodies in the response - the LLM doesn't need the
		// raw diff text just to reason about structure. It can re-request a
		// specific hunk via getAvailablePRHunks if needed.
		const slim = {
			title: doc.title,
			prNumber: doc.prNumber,
			prOwner: doc.prOwner,
			prRepo: doc.prRepo,
			children: slimNodes(doc.children),
		};
		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(JSON.stringify(slim, null, 2)),
		]);
	}
}

function slimNodes(nodes: TourNode[]): unknown[] {
	return nodes.map(n => {
		if (n.type === 'group') {
			return { id: n.id, type: 'group', title: n.title, level: n.level, children: slimNodes(n.children) };
		}
		if (n.type === 'text') {
			return { id: n.id, type: 'text', content: n.content };
		}
		return {
			id: n.id,
			type: 'hunk',
			file: n.hunk.file,
			lines: `${n.hunk.startLine}-${n.hunk.endLine}`,
			highlights: n.hunk.highlights,
			// `pinned` is an author-authored decision (set via the editor's pin
			// button when the hunk has drifted). Surface it to the LLM so it
			// doesn't strip the attribute on rewrites; the LLM does not set it.
			pinned: n.hunk.pinned,
		};
	});
}

// Render the current node ids with a brief content hint so a "not found" error
// is self-recoverable: the LLM can pick the right id from the listing without
// an extra getCurrentTour roundtrip. Node ids are positional and get reassigned
// on every parse, so any id from a previous tool call may already be stale.
function summarizeNodeIds(nodes: TourNode[], indent = ''): string {
	const lines: string[] = [];
	for (const n of nodes) {
		if (n.type === 'group') {
			lines.push(`${indent}${n.id}  group "${n.title}"`);
			if (n.children.length > 0) {
				lines.push(summarizeNodeIds(n.children, indent + '  '));
			}
		} else if (n.type === 'text') {
			const preview = n.content.length > 60 ? n.content.slice(0, 57) + '…' : n.content;
			lines.push(`${indent}${n.id}  text "${preview.replace(/\n/g, ' ')}"`);
		} else {
			lines.push(`${indent}${n.id}  hunk ${n.hunk.file}:${n.hunk.startLine}-${n.hunk.endLine}`);
		}
	}
	return lines.join('\n');
}

const STALE_ID_HINT = 'Node IDs are content-derived and normally stable across edits, but two nodes with identical content (e.g. two text paragraphs with the same wording, two hunks at the same file:lines) share a base ID with a -{N} suffix - removing the first renumbers the rest. Pick the right ID from the listing below (or call changeTour_getCurrentTour to refresh).';

type GetAvailablePRHunksParams = Record<string, never>;

class GetAvailablePRHunksTool implements vscode.LanguageModelTool<GetAvailablePRHunksParams> {
	static readonly toolId = 'changeTour_getAvailablePRHunks';

	constructor(private readonly reposManager: RepositoriesManager) { }

	async prepareInvocation(): Promise<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: vscode.l10n.t('Reading pull request hunks for Change Tour'),
			pastTenseMessage: vscode.l10n.t('Read pull request hunks for Change Tour'),
		};
	}

	async invoke(): Promise<vscode.LanguageModelToolResult> {
		const { folderManager, prOwner, prRepo, prNumber } = await getTourPRContext(this.reposManager);
		const prModel = await withRateLimitGuard(() => folderManager.resolvePullRequest(prOwner, prRepo, prNumber, true));
		if (!prModel) {
			throw new Error(`Could not resolve pull request #${prNumber}.`);
		}
		const changes = await getCachedFileChangesInfo(prModel, prOwner, prRepo, prNumber);

		// The returned shape is what addHunkToTour expects - the LLM should pass
		// `file`, `startLine`, `endLine` back verbatim from this output.
		const fileEntries = changes.map(change => {
			const base: {
				file: string;
				previousFile?: string;
				status: string;
				hunks?: Array<{ startLine: number; endLine: number; oldLines: string; newLines: string; preview: string }>;
				skipReason?: string;
			} = {
				file: change.fileName,
				previousFile: change.previousFileName,
				status: statusToString(change.status),
			};
			if (change instanceof InMemFileChange && change.diffHunks?.length) {
				base.hunks = change.diffHunks.map(hunk => {
					const newEnd = hunk.newLineNumber + Math.max(hunk.newLength, 1) - 1;
					const oldEnd = hunk.oldLineNumber + Math.max(hunk.oldLength, 1) - 1;
					return {
						startLine: hunk.newLineNumber,
						endLine: newEnd,
						oldLines: `${hunk.oldLineNumber}-${oldEnd}`,
						newLines: `${hunk.newLineNumber}-${newEnd}`,
						preview: hunk.diffLines.slice(0, 8).map(l => l.raw).join('\n') + (hunk.diffLines.length > 8 ? '\n…' : ''),
					};
				});
			} else if (!(change instanceof InMemFileChange)) {
				base.skipReason = 'no inline diff available (binary or too large)';
			}
			return base;
		});

		const result = {
			pr: { owner: prOwner, repo: prRepo, number: prNumber },
			contract: 'When calling changeTour_addHunkToTour, pass `file`, `startLine`, and `endLine` exactly from one of the `hunks[]` entries below. The tool resolves ref/patch/previousFile from the pull request automatically.',
			files: fileEntries,
		};

		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
		]);
	}
}

function statusToString(status: GitChangeType): string {
	switch (status) {
		case GitChangeType.ADD: return 'added';
		case GitChangeType.DELETE: return 'deleted';
		case GitChangeType.MODIFY: return 'modified';
		case GitChangeType.RENAME: return 'renamed';
		default: return 'unknown';
	}
}

/**
 * Deterministic drift + coverage report. Computes EXACTLY the same lists the
 * editor's UI surfaces in the outdated banner ("N hunks drifted from the PR",
 * "M hunks not covered"), so the LLM can act on them without having to
 * re-derive drift from raw patches.
 *
 * Without this tool the LLM saw only `(file, lines)` per tour hunk and a
 * separate list of PR hunks, with no way to detect content drift - so it
 * tended to leave drifted hunks in place. With this tool the lists are
 * handed to it directly; its job is just to execute the corrective edits.
 */
type GetDriftReportParams = Record<string, never>;

class GetDriftReportTool implements vscode.LanguageModelTool<GetDriftReportParams> {
	static readonly toolId = 'changeTour_getDriftReport';

	constructor(private readonly reposManager: RepositoriesManager) { }

	async prepareInvocation(): Promise<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: vscode.l10n.t('Checking which Change Tour hunks have drifted from the pull request'),
			pastTenseMessage: vscode.l10n.t('Checked Change Tour drift against the pull request'),
		};
	}

	async invoke(): Promise<vscode.LanguageModelToolResult> {
		const { doc, rawText, folderManager, prOwner, prRepo, prNumber } = await getTourPRContext(this.reposManager);
		const exclusions = parseTourExclusions(rawText);
		const prModel = await withRateLimitGuard(() => folderManager.resolvePullRequest(prOwner, prRepo, prNumber, true));
		if (!prModel) {
			throw new Error(`Could not resolve pull request #${prNumber}.`);
		}
		const changes = await getCachedFileChangesInfo(prModel, prOwner, prRepo, prNumber);

		// Build per-file maps from the current PR: fingerprint set + hunk list.
		const prFingerprintsByFile = new Map<string, Set<string>>();
		const prHunksByFile = new Map<string, Array<{ startLine: number; endLine: number; fp?: string }>>();
		const renamedFrom = new Map<string, string>();
		for (const change of changes) {
			if (change.previousFileName && change.previousFileName !== change.fileName) {
				renamedFrom.set(change.previousFileName, change.fileName);
			}
			if (!(change instanceof InMemFileChange) || !change.diffHunks?.length) {
				continue;
			}
			const fpSet = new Set<string>();
			const hunkList: Array<{ startLine: number; endLine: number; fp?: string }> = [];
			for (const h of change.diffHunks) {
				const newEnd = h.newLineNumber + Math.max(h.newLength, 1) - 1;
				const patch = h.diffLines.map(l => l.raw).join('\n');
				const fp = editContentFingerprint(patch);
				if (fp) fpSet.add(fp);
				hunkList.push({ startLine: h.newLineNumber, endLine: newEnd, fp });
			}
			prFingerprintsByFile.set(change.fileName, fpSet);
			prHunksByFile.set(change.fileName, hunkList);
		}

		const resolvePrFile = (hunkFile: string, hunkPrevious?: string): string | undefined => {
			if (prFingerprintsByFile.has(hunkFile)) return hunkFile;
			const renamed = renamedFrom.get(hunkFile);
			if (renamed && prFingerprintsByFile.has(renamed)) return renamed;
			if (hunkPrevious && prFingerprintsByFile.has(hunkPrevious)) return hunkPrevious;
			return undefined;
		};

		// Walk the tour. For each hunk: classify as fresh / drifted / removed-from-PR.
		const drifted: Array<{ tourNodeId: string; file: string; oldLines: string; reason: string }> = [];
		const removedFromPR: Array<{ tourNodeId: string; file: string; oldLines: string }> = [];
		const coveredFps = new Map<string, Set<string>>(); // PR-file → set of fingerprints the tour already covers
		const addCovered = (file: string, fp: string) => {
			let s = coveredFps.get(file);
			if (!s) { s = new Set(); coveredFps.set(file, s); }
			s.add(fp);
		};

		const walk = (nodes: TourNode[]) => {
			for (const n of nodes) {
				if (n.type === 'hunk') {
					const fingerprintFile = resolvePrFile(n.hunk.file, n.hunk.previousFile);
					const prFps = fingerprintFile ? prFingerprintsByFile.get(fingerprintFile) : undefined;
					const hunkFp = editContentFingerprint(n.hunk.patch);

					if (!fingerprintFile || !prFps) {
						removedFromPR.push({ tourNodeId: n.id, file: n.hunk.file, oldLines: `${n.hunk.startLine}-${n.hunk.endLine}` });
					} else if (n.hunk.pinned) {
						// Pinned hunks are intentional history - never flagged.
						if (hunkFp) addCovered(fingerprintFile, hunkFp);
					} else if (!hunkFp || !prFps.has(hunkFp)) {
						drifted.push({
							tourNodeId: n.id,
							file: n.hunk.file,
							oldLines: `${n.hunk.startLine}-${n.hunk.endLine}`,
							reason: !hunkFp
								? 'tour hunk has no patch content; cannot compare'
								: 'patch content does not match any current PR hunk for this file',
						});
					} else {
						addCovered(fingerprintFile, hunkFp);
					}
				}
				if (n.type === 'group') {
					walk(n.children);
				}
			}
		};
		walk(doc.children);

		// Missing-in-tour: PR hunks no tour hunk covers (by content). Hunks the
		// author has opted out of with a `<!-- changetour:exclude … -->` marker
		// are dropped - the marker is the author's curation signal that those
		// hunks belong out of the tour entirely (autogenerated noise,
		// mechanical changes, etc), so the LLM shouldn't keep proposing to add
		// them.
		const missingInTour: Array<{ file: string; startLine: number; endLine: number }> = [];
		for (const [file, hunks] of prHunksByFile) {
			const covered = coveredFps.get(file);
			for (const h of hunks) {
				if (h.fp && covered && covered.has(h.fp)) continue;
				if (isExcluded(exclusions, file, h.startLine, h.endLine, h.fp)) continue;
				missingInTour.push({ file, startLine: h.startLine, endLine: h.endLine });
			}
		}

		const result = {
			contract: [
				`This tour has ${drifted.length} drifted hunk(s), ${missingInTour.length} hunk(s) new in the PR not yet covered, and ${removedFromPR.length} hunk(s) that no longer exist in the PR.`,
				'Drifted: remove via changeTour_removeTourNode (use `tourNodeId`), then re-insert via changeTour_addHunkToTour (use one of the current PR hunks for that file from changeTour_getAvailablePRHunks).',
				'Missing in tour: add via changeTour_addHunkToTour, placed into the most appropriate section.',
				'Removed from PR: remove via changeTour_removeTourNode plus any narration that was specific to it.',
				'Pinned hunks are intentional history and are never reported here.',
				exclusions.length > 0
					? `${exclusions.length} PR hunk(s) are filtered out by author-curated exclusion markers and are intentionally omitted from missingInTour - do NOT add them to the tour. Use changeTour_removeExclusion if a marker is now wrong.`
					: 'For hunks that belong out of the tour entirely (autogenerated noise under `dist/**` / `src/generated/**`), call changeTour_addExclusion (exact-range, whole-file, or glob form) instead of inserting them into the tour. Prefer the glob form for autogenerated directories so the marker survives regen. Deleted files (new-side 0-0) can be added to the tour normally and usually belong in Miscellaneous - reach for exclusion only when the deletion is itself mechanical noise.',
			],
			drifted,
			missingInTour,
			removedFromPR,
		};
		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
		]);
	}
}

/* ----- Write tools ---------------------------------------- */

interface AddSectionParams {
	title: string;
	level?: number;
	anchor: NodeAnchor;
}

class AddSectionTool implements vscode.LanguageModelTool<AddSectionParams> {
	static readonly toolId = 'changeTour_addSectionToTour';

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<AddSectionParams>): Promise<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: vscode.l10n.t('Adding section "{0}"', options.input.title),
			pastTenseMessage: vscode.l10n.t('Added section "{0}"', options.input.title),
		};
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<AddSectionParams>): Promise<vscode.LanguageModelToolResult> {
		const { title, level, anchor } = options.input;
		const newId = newLocalId();
		await applyMutation(({ doc }) => {
			const node: TourGroupNode = {
				type: 'group',
				id: newId,
				title,
				level: clampLevel(level ?? 2),
				children: [],
			};
			if (!insertAt(doc, anchor, node)) {
				throw new Error(`Could not insert section - the anchor target was not found.`);
			}
		});
		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(`Added section "${title}". Re-fetch the tour to see updated node ids.`),
		]);
	}
}

interface AddTextNodeParams {
	content: string;
	anchor: NodeAnchor;
}

class AddTextNodeTool implements vscode.LanguageModelTool<AddTextNodeParams> {
	static readonly toolId = 'changeTour_addTextNodeToTour';

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<AddTextNodeParams>): Promise<vscode.PreparedToolInvocation> {
		const preview = options.input.content.length > 60 ? options.input.content.slice(0, 60) + '…' : options.input.content;
		return {
			invocationMessage: vscode.l10n.t('Adding narration: "{0}"', preview),
			pastTenseMessage: vscode.l10n.t('Added narration: "{0}"', preview),
		};
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<AddTextNodeParams>): Promise<vscode.LanguageModelToolResult> {
		const { content, anchor } = options.input;
		const newId = newLocalId();
		await applyMutation(({ doc }) => {
			const node: TourTextNode = { type: 'text', id: newId, content };
			if (!insertAt(doc, anchor, node)) {
				throw new Error(`Could not insert text - the anchor target was not found.`);
			}
		});
		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart('Added narration. Re-fetch the tour to see updated node ids.'),
		]);
	}
}

interface AddHunkParams {
	/** File path relative to the repo root - must exactly match a file changed by the bound PR. */
	file: string;
	/** First line (new-side, 1-indexed) - must match `newLineNumber` of a real hunk. */
	startLine: number;
	/** Last line (new-side, inclusive) - must match `newLineNumber + newLength - 1` of the same hunk. */
	endLine: number;
	/** Optional highlight ranges within the hunk. */
	highlights?: HighlightRange[];
	anchor: NodeAnchor;
}

class AddHunkTool implements vscode.LanguageModelTool<AddHunkParams> {
	static readonly toolId = 'changeTour_addHunkToTour';

	constructor(private readonly reposManager: RepositoriesManager) { }

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<AddHunkParams>): Promise<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: vscode.l10n.t('Adding hunk {0}:{1}-{2}', options.input.file, options.input.startLine, options.input.endLine),
			pastTenseMessage: vscode.l10n.t('Added hunk {0}:{1}-{2}', options.input.file, options.input.startLine, options.input.endLine),
		};
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<AddHunkParams>): Promise<vscode.LanguageModelToolResult> {
		const { file, startLine, endLine, highlights, anchor } = options.input;
		// Resolve the hunk against the active PR's diff BEFORE mutating - this is the validity gate.
		// If the LLM passed a file/range that isn't in the PR, this throws and the tool call errors
		// out cleanly instead of writing a broken hunk into the document.
		const resolved = await resolveHunkInActivePR(this.reposManager, file, startLine, endLine);
		if (highlights && highlights.length > 0) {
			resolved.highlights = highlights;
		}
		const newId = newLocalId();
		let droppedMarkerCount = 0;
		await applyMutation(({ doc }) => {
			// Enforce no-overlap between the tour and the excluded list. If a
			// marker matches the hunk being added:
			//   - Exact-range markers are truly redundant once the hunk is in
			//     the tour; silently drop them.
			//   - Whole-file / glob markers cover MANY hunks; silently dropping
			//     one would un-exclude every other hunk in that file/pattern.
			//     Refuse the add and tell the caller to remove the marker
			//     deliberately via changeTour_removeExclusion if they want to
			//     proceed.
			const existing = doc.exclusions ?? [];
			const matchingMarkers = findMarkersMatchingHunk(existing, file, startLine, endLine, editContentFingerprint(resolved.patch));
			const broad = matchingMarkers.filter(m => !isExactRangeMarker(m));
			if (broad.length > 0) {
				const summary = broad
					.map(m => `file="${m.file}"${m.reason ? ` (reason: ${m.reason})` : ''}`)
					.join('; ');
				throw new Error(
					`Cannot add ${file}:${startLine}-${endLine} to the tour: it is covered by ${broad.length} whole-file / glob exclusion marker(s) -- ${summary}. ` +
					`Removing them silently would un-exclude every other hunk they match, so this call refuses. ` +
					`Call changeTour_removeExclusion on the marker first if you want to add this hunk to the tour.`,
				);
			}
			const exactMatches = matchingMarkers.filter(m => isExactRangeMarker(m));
			if (exactMatches.length > 0) {
				doc.exclusions = existing.filter(m => !exactMatches.includes(m));
				droppedMarkerCount = exactMatches.length;
			}
			const node: TourHunkNode = { type: 'hunk', id: newId, hunk: resolved };
			if (!insertAt(doc, anchor, node)) {
				throw new Error(`Could not insert hunk - the anchor target was not found.`);
			}
		});
		const suffix = droppedMarkerCount > 0
			? ` Also dropped ${droppedMarkerCount} redundant exact-range exclusion marker(s) that matched this hunk.`
			: '';
		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(`Added hunk ${file}:${startLine}-${endLine}.${suffix} Re-fetch the tour to see updated node ids.`),
		]);
	}
}

interface SetHunkHighlightsParams {
	hunkId: string;
	highlights: HighlightRange[];
}

class SetHunkHighlightsTool implements vscode.LanguageModelTool<SetHunkHighlightsParams> {
	static readonly toolId = 'changeTour_setHunkHighlights';

	async prepareInvocation(): Promise<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: vscode.l10n.t('Updating hunk highlights'),
			pastTenseMessage: vscode.l10n.t('Updated hunk highlights'),
		};
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<SetHunkHighlightsParams>): Promise<vscode.LanguageModelToolResult> {
		const { hunkId, highlights } = options.input;
		let found = false;
		let summary = '';
		await applyMutation(({ doc }) => {
			updateHunk(doc.children, hunkId, h => {
				h.highlights = highlights.length > 0 ? highlights : undefined;
				found = true;
			});
			if (!found) {
				summary = summarizeNodeIds(doc.children);
			}
		});
		if (!found) {
			throw new Error(
				`Hunk with id "${hunkId}" was not found in the tour. ${STALE_ID_HINT}\n\nCurrent nodes:\n${summary || '(tour is empty)'}`,
			);
		}
		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart('Highlights updated.'),
		]);
	}
}

interface SetHunkSummaryParams {
	hunkId: string;
	summary: string;
}

class SetHunkSummaryTool implements vscode.LanguageModelTool<SetHunkSummaryParams> {
	static readonly toolId = 'changeTour_setHunkSummary';

	async prepareInvocation(): Promise<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: vscode.l10n.t('Updating hunk summary'),
			pastTenseMessage: vscode.l10n.t('Updated hunk summary'),
		};
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<SetHunkSummaryParams>): Promise<vscode.LanguageModelToolResult> {
		const { hunkId, summary } = options.input;
		const trimmed = typeof summary === 'string' ? summary.trim() : '';
		let found = false;
		let nodeSummary = '';
		await applyMutation(({ doc }) => {
			updateHunk(doc.children, hunkId, h => {
				h.summary = trimmed.length > 0 ? trimmed : undefined;
				found = true;
			});
			if (!found) {
				nodeSummary = summarizeNodeIds(doc.children);
			}
		});
		if (!found) {
			throw new Error(
				`Hunk with id "${hunkId}" was not found in the tour. ${STALE_ID_HINT}\n\nCurrent nodes:\n${nodeSummary || '(tour is empty)'}`,
			);
		}
		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(trimmed.length > 0 ? 'Summary updated.' : 'Summary cleared.'),
		]);
	}
}

function updateHunk(nodes: TourNode[], hunkId: string, mutator: (h: HunkReference) => void): void {
	for (const node of nodes) {
		if (node.type === 'hunk' && node.id === hunkId) {
			mutator(node.hunk);
			return;
		}
		if (node.type === 'group') {
			updateHunk(node.children, hunkId, mutator);
		}
	}
}

interface RemoveNodeParams {
	nodeId: string;
}

class RemoveNodeTool implements vscode.LanguageModelTool<RemoveNodeParams> {
	static readonly toolId = 'changeTour_removeTourNode';

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<RemoveNodeParams>): Promise<vscode.PreparedToolInvocation> {
		return {
			invocationMessage: vscode.l10n.t('Removing node {0}', options.input.nodeId),
			pastTenseMessage: vscode.l10n.t('Removed node {0}', options.input.nodeId),
		};
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<RemoveNodeParams>): Promise<vscode.LanguageModelToolResult> {
		const { nodeId } = options.input;
		let removed = false;
		let summary = '';
		await applyMutation(({ doc }) => {
			const res = extractNodeById<TourNode>(doc.children, nodeId);
			if (res.extracted) {
				doc.children = res.nodes;
				removed = true;
			} else {
				summary = summarizeNodeIds(doc.children);
			}
		});
		if (!removed) {
			throw new Error(
				`Node with id "${nodeId}" was not found. ${STALE_ID_HINT}\n\nCurrent nodes:\n${summary || '(tour is empty)'}`,
			);
		}
		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(`Removed node ${nodeId}.`),
		]);
	}
}

function clampLevel(level: number): number {
	if (!Number.isFinite(level)) return 2;
	return Math.max(2, Math.min(6, Math.floor(level)));
}

/* ----- Exclusion mutations -------------------------------- */

interface AddExclusionParams {
	/** Literal repo-relative path OR a glob pattern (`*`/`**`). */
	file: string;
	/** Optional new-side start line. Required when `endLine` is set; omit both for whole-file/glob. */
	startLine?: number;
	/** Optional new-side end line. Required when `startLine` is set; omit both for whole-file/glob. */
	endLine?: number;
	/** Optional free-form rationale shown to reviewers. Strongly recommended. */
	reason?: string;
}

class AddExclusionTool implements vscode.LanguageModelTool<AddExclusionParams> {
	static readonly toolId = 'changeTour_addExclusion';

	constructor(private readonly reposManager: RepositoriesManager) { }

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<AddExclusionParams>): Promise<vscode.PreparedToolInvocation> {
		const { file, startLine, endLine } = options.input;
		const target = startLine !== undefined && endLine !== undefined
			? `${file}:${startLine}-${endLine}`
			: file;
		return {
			invocationMessage: vscode.l10n.t('Excluding {0} from the Change Tour', target),
			pastTenseMessage: vscode.l10n.t('Excluded {0} from the Change Tour', target),
		};
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<AddExclusionParams>): Promise<vscode.LanguageModelToolResult> {
		const { file, startLine, endLine, reason } = options.input;
		if (!file || typeof file !== 'string') {
			throw new Error('`file` is required (repo-relative path or glob pattern).');
		}
		const hasStart = startLine !== undefined;
		const hasEnd = endLine !== undefined;
		if (hasStart !== hasEnd) {
			throw new Error('`startLine` and `endLine` must be provided together (or both omitted for a whole-file / glob marker).');
		}
		if (hasStart && hasEnd) {
			// Deletions are represented as `startLine: 0, endLine: 0` (their
			// new-side range is empty) - that's a valid hunk identity in the
			// rest of the data model, so it must be a valid exclusion target too.
			// Reject only ranges that are inverted or negative.
			if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine! < 0 || endLine! < startLine!) {
				throw new Error(`Invalid line range ${startLine}-${endLine}. Both bounds must be non-negative integers with startLine <= endLine.`);
			}
			if (isGlob(file)) {
				throw new Error('Glob patterns cannot carry a line range. Drop `startLine`/`endLine` (the marker will match every hunk in every matching file) or pass a literal `file` path.');
			}
		}
		// Best-effort fingerprint: for exact-range markers, look up the PR
		// hunk's patch and fingerprint it so the marker matches the same edit
		// even after a rebase shifts the line numbers. Glob and whole-file
		// markers don't target a single hunk, so we leave fp unset for those.
		let fp: string | undefined;
		if (hasStart && hasEnd && !isGlob(file)) {
			try {
				const resolved = await resolveHunkInActivePR(this.reposManager, file, startLine!, endLine!);
				fp = editContentFingerprint(resolved.patch);
			} catch {
				// File or range not found in PR - tolerate this and write a
				// line-only marker. The drift report will still match by line.
			}
		}
		const marker: ExcludedHunkMarker = {
			file,
			startLine: hasStart ? startLine : undefined,
			endLine: hasEnd ? endLine : undefined,
			fp,
			reason: reason?.trim() || undefined,
		};
		let alreadyExisted = false;
		await applyMutation(({ doc }) => {
			const existing = doc.exclusions ?? [];
			for (const e of existing) {
				if (e.file === marker.file && e.startLine === marker.startLine && e.endLine === marker.endLine) {
					alreadyExisted = true;
					return;
				}
			}
			// Enforce no-overlap between the tour and the excluded list. If
			// this marker would match any tour hunk currently in the tour,
			// refuse the add so the curated narrative wins. The caller has to
			// decide whether to remove the tour hunk(s) first or skip the
			// exclusion.
			const conflicting = findTourHunksMatchingMarker(doc.children, marker, h => editContentFingerprint(h.patch));
			if (conflicting.length > 0) {
				const sample = conflicting
					.slice(0, 5)
					.map(n => `${n.hunk.file}:${n.hunk.startLine}-${n.hunk.endLine} (nodeId=${n.id})`)
					.join('; ');
				const more = conflicting.length > 5 ? `, +${conflicting.length - 5} more` : '';
				throw new Error(
					`Cannot exclude ${marker.startLine !== undefined ? `${marker.file}:${marker.startLine}-${marker.endLine}` : marker.file}: ` +
					`${conflicting.length} tour hunk(s) are already covered by this marker -- ${sample}${more}. ` +
					`Remove those tour nodes via changeTour_removeTourNode first if you want to exclude them, or pick a more specific marker that doesn't overlap.`,
				);
			}
			doc.exclusions = [...existing, marker];
		});
		const target = marker.startLine !== undefined && marker.endLine !== undefined
			? `${marker.file}:${marker.startLine}-${marker.endLine}`
			: marker.file;
		const verb = alreadyExisted ? 'already excluded' : 'Excluded';
		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(`${verb} ${target}. The marker now lives in the tour's appendix and the drift report will skip it on the next changeTour_getDriftReport call.`),
		]);
	}
}

interface RemoveExclusionParams {
	/** Literal path or glob pattern matching the marker's `file=` attribute exactly. */
	file: string;
	/** Optional new-side range matching the marker's `lines=` attribute. Omit when the marker has no `lines=`. */
	startLine?: number;
	endLine?: number;
}

class RemoveExclusionTool implements vscode.LanguageModelTool<RemoveExclusionParams> {
	static readonly toolId = 'changeTour_removeExclusion';

	async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<RemoveExclusionParams>): Promise<vscode.PreparedToolInvocation> {
		const { file, startLine, endLine } = options.input;
		const target = startLine !== undefined && endLine !== undefined
			? `${file}:${startLine}-${endLine}`
			: file;
		return {
			invocationMessage: vscode.l10n.t('Removing exclusion {0}', target),
			pastTenseMessage: vscode.l10n.t('Removed exclusion {0}', target),
		};
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<RemoveExclusionParams>): Promise<vscode.LanguageModelToolResult> {
		const { file, startLine, endLine } = options.input;
		const hasStart = startLine !== undefined;
		const hasEnd = endLine !== undefined;
		if (hasStart !== hasEnd) {
			throw new Error('`startLine` and `endLine` must be provided together (or both omitted to match a whole-file / glob marker).');
		}
		let removed = false;
		await applyMutation(({ doc }) => {
			const before = doc.exclusions ?? [];
			const after = before.filter(e => !(
				e.file === file
				&& e.startLine === (hasStart ? startLine : undefined)
				&& e.endLine === (hasEnd ? endLine : undefined)
			));
			if (after.length !== before.length) {
				removed = true;
				doc.exclusions = after;
			}
		});
		if (!removed) {
			throw new Error(`No exclusion marker matched (file=${file}, lines=${hasStart ? `${startLine}-${endLine}` : '<none>'}). Run changeTour_getDriftReport or read the appendix to confirm the exact attributes.`);
		}
		const target = hasStart ? `${file}:${startLine}-${endLine}` : file;
		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(`Removed exclusion for ${target}. The hunk(s) it filtered will reappear in the next changeTour_getDriftReport's missingInTour list if still uncovered.`),
		]);
	}
}

/* ----- Registration --------------------------------------- */

export function registerTourAssistantTools(context: vscode.ExtensionContext, reposManager: RepositoriesManager): void {
	const registered = new Set<string>();
	const register = (toolId: string, tool: vscode.LanguageModelTool<any>): void => {
		registered.add(toolId);
		context.subscriptions.push(vscode.lm.registerTool(toolId, tool));
	};
	register(GetCurrentTourTool.toolId, new GetCurrentTourTool());
	register(GetAvailablePRHunksTool.toolId, new GetAvailablePRHunksTool(reposManager));
	register(GetDriftReportTool.toolId, new GetDriftReportTool(reposManager));
	register(AddSectionTool.toolId, new AddSectionTool());
	register(AddTextNodeTool.toolId, new AddTextNodeTool());
	register(AddHunkTool.toolId, new AddHunkTool(reposManager));
	register(SetHunkHighlightsTool.toolId, new SetHunkHighlightsTool());
	register(SetHunkSummaryTool.toolId, new SetHunkSummaryTool());
	register(RemoveNodeTool.toolId, new RemoveNodeTool());
	register(AddExclusionTool.toolId, new AddExclusionTool(reposManager));
	register(RemoveExclusionTool.toolId, new RemoveExclusionTool());

	// Guard against drift between the VS Code LM registry and the
	// provider-agnostic spec list. The Anthropic backend only sees tools that
	// appear in getTourAssistantToolSpecs(); silently dropping one means the
	// model is told to use it (via prompts / error messages) but has no way
	// to call it. Throw at activation so the divergence is impossible to ship.
	const specIds = new Set(getTourAssistantToolSpecs().map(s => s.name));
	const missingFromSpecs = [...registered].filter(id => !specIds.has(id));
	const missingFromRegistry = [...specIds].filter(id => !registered.has(id));
	if (missingFromSpecs.length > 0 || missingFromRegistry.length > 0) {
		const parts: string[] = [];
		if (missingFromSpecs.length > 0) {
			parts.push(`registered with VS Code LM but missing from getTourAssistantToolSpecs() (Anthropic backend can't call them): ${missingFromSpecs.join(', ')}`);
		}
		if (missingFromRegistry.length > 0) {
			parts.push(`declared in getTourAssistantToolSpecs() but not registered with VS Code LM: ${missingFromRegistry.join(', ')}`);
		}
		throw new Error(`Change Tour assistant tool registry is out of sync. ${parts.join('; ')}.`);
	}
}

/**
 * Tool specs in the provider-agnostic format used by the orchestrator. The
 * orchestrator passes these to `provider.streamChat({ tools: ... })`.
 */
export function getTourAssistantToolSpecs(): { name: string; description: string; inputSchema: object }[] {
	return [
		{
			name: GetCurrentTourTool.toolId,
			description: 'Read the currently open Change Tour document as JSON (title, PR metadata, and node tree with IDs). Always call this before mutating the tour so you reference current node IDs.',
			inputSchema: { type: 'object', properties: {} },
		},
		{
			name: GetAvailablePRHunksTool.toolId,
			description: 'List every changed file + hunk in the pull request that the active Change Tour is bound to. Returns file paths, status (added/modified/deleted), and hunk line ranges with a preview.',
			inputSchema: { type: 'object', properties: {} },
		},
		{
			name: GetDriftReportTool.toolId,
			description: 'Deterministic drift + coverage report for the active Change Tour. Returns three lists: hunks in the tour whose patch content no longer matches any current PR hunk (drifted), PR hunks no tour hunk covers by content (missingInTour), and tour hunks whose file is no longer in the PR diff (removedFromPR). Call this FIRST in the update flow - it is the ground truth for what needs to change.',
			inputSchema: { type: 'object', properties: {} },
		},
		{
			name: AddSectionTool.toolId,
			description: 'Insert a new section (heading) into the tour at the given anchor. Sections group related text and hunks.',
			inputSchema: {
				type: 'object',
				properties: {
					title: { type: 'string', description: 'Section heading text.' },
					level: { type: 'number', description: 'Heading level 2-6 (default 2). Use 3+ for sub-sections.' },
					anchor: NODE_ANCHOR_SCHEMA,
				},
				required: ['title', 'anchor'],
			},
		},
		{
			name: AddTextNodeTool.toolId,
			description: 'Insert a narration paragraph (markdown) into the tour at the given anchor. Keep narration short (1-3 sentences) and explain WHY a change is there, not WHAT it does.',
			inputSchema: {
				type: 'object',
				properties: {
					content: { type: 'string', description: 'Markdown content of the narration.' },
					anchor: NODE_ANCHOR_SCHEMA,
				},
				required: ['content', 'anchor'],
			},
		},
		{
			name: AddHunkTool.toolId,
			description: 'Insert a hunk reference into the tour at the given anchor. Identify the hunk by `file` + `startLine` + `endLine` - these MUST come verbatim from a `hunks[]` entry returned by changeTour_getAvailablePRHunks. The tool looks up the ref, patch, and previousFile from the active pull request automatically; passing a file/range that does not match a real hunk fails the call.',
			inputSchema: {
				type: 'object',
				properties: {
					file: { type: 'string', description: 'Repo-relative file path. Must match a file changed by the bound pull request.' },
					startLine: { type: 'number', description: 'First line on the new side (1-indexed). Must match `startLine` of a hunk in getAvailablePRHunks output.' },
					endLine: { type: 'number', description: 'Last line on the new side (inclusive). Must match `endLine` of the same hunk.' },
					highlights: {
						type: 'array',
						description: 'Optional list of sub-line-ranges to visually emphasize within the hunk.',
						items: {
							type: 'object',
							properties: {
								side: { type: 'string', enum: ['old', 'new'] },
								start: { type: 'number' },
								end: { type: 'number' },
							},
							required: ['side', 'start', 'end'],
						},
					},
					anchor: NODE_ANCHOR_SCHEMA,
				},
				required: ['file', 'startLine', 'endLine', 'anchor'],
			},
		},
		{
			name: SetHunkHighlightsTool.toolId,
			description: 'Replace the highlight ranges on an existing hunk. Pass an empty array to remove all highlights.',
			inputSchema: {
				type: 'object',
				properties: {
					hunkId: { type: 'string', description: 'ID of the hunk node (from getCurrentTour).' },
					highlights: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								side: { type: 'string', enum: ['old', 'new'] },
								start: { type: 'number' },
								end: { type: 'number' },
							},
							required: ['side', 'start', 'end'],
						},
					},
				},
				required: ['hunkId', 'highlights'],
			},
		},
		{
			name: SetHunkSummaryTool.toolId,
			description: 'Set or clear the one-line natural-language summary on an existing hunk. The summary is shown inline in the hunk header in both edit and viewer modes; without one, readers see a generic auto-fallback (the first changed line of the patch). Use this to give long or non-obvious hunks an informative header label. Pass an empty string to clear and fall back to the auto default.',
			inputSchema: {
				type: 'object',
				properties: {
					hunkId: { type: 'string', description: 'ID of the hunk node (from getCurrentTour).' },
					summary: { type: 'string', description: 'One-sentence description (120 chars or less). Empty string clears the summary.' },
				},
				required: ['hunkId', 'summary'],
			},
		},
		{
			name: RemoveNodeTool.toolId,
			description: 'Remove a node (group, text, or hunk) from the tour by id. The user must confirm in the UI. Use sparingly.',
			inputSchema: {
				type: 'object',
				properties: {
					nodeId: { type: 'string', description: 'ID of the node to remove (from getCurrentTour).' },
				},
				required: ['nodeId'],
			},
		},
		{
			name: AddExclusionTool.toolId,
			description: 'Add an exclusion marker so the drift report stops nagging about a hunk / file / glob that the author has intentionally left out of the tour. Three forms: (1) exact range -- pass `file` + `startLine` + `endLine`; (2) whole file -- pass just `file` (literal path); (3) glob -- pass a `file` pattern using `*`/`**` (e.g. `dist/**`, `src/generated/**`). Prefer the glob form for autogenerated directories so the marker survives regen. Fails if any hunk currently in the tour is already covered by the marker - remove those nodes first if you really want to exclude them.',
			inputSchema: {
				type: 'object',
				properties: {
					file: { type: 'string', description: 'Repo-relative file path OR glob pattern (`*`/`**`). For globs, omit startLine/endLine.' },
					startLine: { type: 'number', description: 'Optional first line on the new side. Use 1-indexed lines for additions/modifications, or `0` (paired with `endLine: 0`) for a whole-file deletion - whatever `getAvailablePRHunks` reports. Required together with endLine; omit both for whole-file / glob exclusions.' },
					endLine: { type: 'number', description: 'Optional last line on the new side (inclusive). Required together with startLine. Pass `0` for a whole-file deletion (paired with `startLine: 0`).' },
					reason: { type: 'string', description: 'Free-form rationale shown to reviewers (strongly recommended).' },
				},
				required: ['file'],
			},
		},
		{
			name: RemoveExclusionTool.toolId,
			description: 'Remove an existing exclusion marker so its hunks are back in scope for the drift report. Match the marker exactly: pass the same `file` (literal path or glob) and the same `startLine`/`endLine` it was created with (omit both if the marker had no line range). Inspect getDriftReport output or the tour appendix to see the live markers.',
			inputSchema: {
				type: 'object',
				properties: {
					file: { type: 'string', description: 'Literal path or glob pattern matching the marker\'s `file=` attribute exactly.' },
					startLine: { type: 'number', description: 'Optional new-side first line matching the marker\'s `lines=` attribute. Required together with endLine; omit both when the marker has no line range.' },
					endLine: { type: 'number', description: 'Optional new-side last line matching the marker\'s `lines=` attribute. Required together with startLine.' },
				},
				required: ['file'],
			},
		},
	];
}
