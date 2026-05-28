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
	HighlightRange,
	HunkReference,
	parseCodeTourMarkdown,
	serializeCodeTourMarkdown,
	TourGroupNode,
	TourHunkNode,
	TourNode,
	TourTextNode,
} from '../../github/codeTourMarkdown';
import { appendNodeToGroupEnd, extractNodeById, insertNodeRelative } from '../../github/codeTourTreeHelpers';
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
		throw new Error('No Change Tour editor is currently active. Open a .codetour.md file and focus its editor before using assistant tools.');
	}
	return document;
}

let _localIdCounter = 0;
function newLocalId(): string {
	return `assistant-${Date.now()}-${_localIdCounter++}`;
}

/**
 * Resolves the pull request that the active Change Tour is bound to via its
 * frontmatter (isPR/prNumber/prOwner/prRepo). The assistant tools rely on this
 * to look up real hunk content rather than trusting the LLM to invent it.
 */
async function getTourPRContext(reposManager: RepositoriesManager): Promise<{ doc: CodeTourDocument; prOwner: string; prRepo: string; prNumber: number; folderManager: NonNullable<ReturnType<RepositoriesManager['getManagerForRepository']>> }> {
	const document = getActiveTourDocument();
	const doc = parseCodeTourMarkdown(document.getText());
	if (!doc.isPR || !doc.prOwner || !doc.prRepo || doc.prNumber === undefined) {
		throw new Error('The active Change Tour is not bound to a pull request. Create the tour via the "Pull Request: New Change Tour" command so it includes the required frontmatter (isPR, prNumber, prOwner, prRepo, baseRef).');
	}
	const folderManager = reposManager.getManagerForRepository(doc.prOwner, doc.prRepo);
	if (!folderManager) {
		throw new Error(`No folder manager found for ${doc.prOwner}/${doc.prRepo}. Make sure the repository is open in the workspace.`);
	}
	return { doc, prOwner: doc.prOwner, prRepo: doc.prRepo, prNumber: doc.prNumber, folderManager };
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
	const prModel = await folderManager.resolvePullRequest(prOwner, prRepo, prNumber);
	if (!prModel) {
		throw new Error(`Could not resolve pull request #${prNumber} for ${prOwner}/${prRepo}.`);
	}
	const changes = await prModel.getFileChangesInfo();
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
		ref: 'HEAD', // Matches the convention used by the drag-from-changes-view path in changesOverview.tsx.
		patch,
		previousFile: fileChange.previousFileName,
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

/** Insert a node into the document at the position described by `anchor`. */
function insertAt(doc: CodeTourDocument, anchor: NodeAnchor, node: TourNode): boolean {
	if (anchor.endOfDocument) {
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
			isPR: doc.isPR,
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
			ref: n.hunk.ref,
			highlights: n.hunk.highlights,
		};
	});
}

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
		const prModel = await folderManager.resolvePullRequest(prOwner, prRepo, prNumber);
		if (!prModel) {
			throw new Error(`Could not resolve pull request #${prNumber}.`);
		}
		const changes = await prModel.getFileChangesInfo();

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
		await applyMutation(({ doc }) => {
			const node: TourHunkNode = { type: 'hunk', id: newId, hunk: resolved };
			if (!insertAt(doc, anchor, node)) {
				throw new Error(`Could not insert hunk - the anchor target was not found.`);
			}
		});
		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(`Added hunk ${file}:${startLine}-${endLine}. Re-fetch the tour to see updated node ids.`),
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
		await applyMutation(({ doc }) => {
			updateHunk(doc.children, hunkId, h => {
				h.highlights = highlights.length > 0 ? highlights : undefined;
				found = true;
			});
		});
		if (!found) {
			throw new Error(`Hunk with id "${hunkId}" was not found in the tour.`);
		}
		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart('Highlights updated.'),
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
			confirmationMessages: {
				title: vscode.l10n.t('Remove Change Tour node'),
				message: vscode.l10n.t('Allow the assistant to remove node "{0}" from the Change Tour? You can undo this with Ctrl/Cmd+Z.', options.input.nodeId),
			},
		};
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<RemoveNodeParams>): Promise<vscode.LanguageModelToolResult> {
		const { nodeId } = options.input;
		let removed = false;
		await applyMutation(({ doc }) => {
			const res = extractNodeById<TourNode>(doc.children, nodeId);
			if (res.extracted) {
				doc.children = res.nodes;
				removed = true;
			}
		});
		if (!removed) {
			throw new Error(`Node with id "${nodeId}" was not found.`);
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

/* ----- Registration --------------------------------------- */

export function registerTourAssistantTools(context: vscode.ExtensionContext, reposManager: RepositoriesManager): void {
	context.subscriptions.push(vscode.lm.registerTool(GetCurrentTourTool.toolId, new GetCurrentTourTool()));
	context.subscriptions.push(vscode.lm.registerTool(GetAvailablePRHunksTool.toolId, new GetAvailablePRHunksTool(reposManager)));
	context.subscriptions.push(vscode.lm.registerTool(AddSectionTool.toolId, new AddSectionTool()));
	context.subscriptions.push(vscode.lm.registerTool(AddTextNodeTool.toolId, new AddTextNodeTool()));
	context.subscriptions.push(vscode.lm.registerTool(AddHunkTool.toolId, new AddHunkTool(reposManager)));
	context.subscriptions.push(vscode.lm.registerTool(SetHunkHighlightsTool.toolId, new SetHunkHighlightsTool()));
	context.subscriptions.push(vscode.lm.registerTool(RemoveNodeTool.toolId, new RemoveNodeTool()));
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
	];
}
