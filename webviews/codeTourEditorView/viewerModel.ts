/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type {
	CodeTourDocument,
	HunkReference,
	TourGroupNode,
	TourHunkNode,
	TourNode,
} from '../../src/github/codeTourMarkdown';

export interface FileHunkGroup {
	file: string;
	hunks: TourHunkNode[];
}

/**
 * Snapshot of the bound PR's current state, supplied by the extension via the
 * `codeTourEditor.changesData` message and consumed by the outdated-detection
 * helpers below. Optional fields tolerate the "PR not resolved / offline /
 * unbound" path - the helpers degrade to "no drift detected" when fields are
 * missing.
 */
export interface PrState {
	currentHeadSha?: string;
	files?: Array<{
		fileName: string;
		previousFileName?: string;
		patch?: string;
		blobSha?: string;
	}>;
}

/**
 * Pre-computed per-file maps derived from a {@link PrState}. Lifted out so the
 * detection helpers and the auto-update flow can share one parse pass.
 */
export interface PrStateIndex {
	blobsByFile: Map<string, string>;
	/** Per-file hunk list (new-side line range + raw patch text for that hunk). */
	hunksByFile: Map<string, Array<{ startLine: number; endLine: number; patch: string }>>;
	/** Reverse rename lookup: previousFile → current fileName. */
	renamedFrom: Map<string, string>;
	/** Per-file set of edit-content fingerprints (see `editContentFingerprint`). Used to detect "the file changed but THIS hunk's edit is unchanged - only surrounding lines shifted." */
	editFingerprintsByFile: Map<string, Set<string>>;
}

/**
 * Build the per-file maps the detection helpers walk. Cheap to call - the
 * patch parsing is a single linear sweep over each file's diff text.
 *
 * Returns an empty index when `prState` is missing or empty so callers can
 * unconditionally consume the result without nil-checking.
 */
export function indexPrState(prState: PrState | undefined): PrStateIndex {
	const blobsByFile = new Map<string, string>();
	const hunksByFile = new Map<string, Array<{ startLine: number; endLine: number; patch: string }>>();
	const renamedFrom = new Map<string, string>();
	const editFingerprintsByFile = new Map<string, Set<string>>();
	if (!prState?.files) {
		return { blobsByFile, hunksByFile, renamedFrom, editFingerprintsByFile };
	}
	for (const f of prState.files) {
		if (f.blobSha) {
			blobsByFile.set(f.fileName, f.blobSha);
		}
		if (f.previousFileName && f.previousFileName !== f.fileName) {
			renamedFrom.set(f.previousFileName, f.fileName);
		}
		if (f.patch) {
			const hunks = extractHunksFromPatch(f.patch);
			if (hunks.length > 0) {
				hunksByFile.set(f.fileName, hunks);
				const fingerprints = new Set<string>();
				for (const h of hunks) {
					const fp = editContentFingerprint(h.patch);
					if (fp !== undefined) {
						fingerprints.add(fp);
					}
				}
				if (fingerprints.size > 0) {
					editFingerprintsByFile.set(f.fileName, fingerprints);
				}
			}
		}
	}
	return { blobsByFile, hunksByFile, renamedFrom, editFingerprintsByFile };
}

/**
 * Reduce a unified-diff patch body to just its add/remove content - the
 * lines that *actually* describe the edit, with no surrounding context and
 * no `@@` header. Two patches whose edit content is byte-identical describe
 * the same change even if the surrounding file has shifted (the position
 * line numbers and the context lines differ but the +/- lines don't).
 *
 * Used by drift and coverage detection to distinguish "this hunk's content
 * is unchanged, only its surroundings shifted" from "this hunk was actually
 * rewritten in the PR".
 */
export function editContentFingerprint(patch: string | undefined): string | undefined {
	if (!patch) {
		return undefined;
	}
	const out: string[] = [];
	for (const rawLine of patch.split('\n')) {
		// Strip trailing CR so CRLF-terminated patches (drag/drop, live PR
		// fetch use `split('\n')` which leaves `\r`) match LF-terminated ones
		// (LLM-tool path goes through LineReader which already stripped CR).
		// Without this, tours authored via the LLM never coverage-match
		// against the same hunk re-fetched from GitHub.
		const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
		if (line.length === 0 || line.startsWith('@@')) {
			continue;
		}
		const marker = line[0];
		if (marker === '+' || marker === '-') {
			out.push(line);
		}
	}
	return out.join('\n');
}

/**
 * Split a unified-diff patch into per-hunk slices, each with its new-side
 * `(startLine, endLine)` and the raw patch text for that hunk (starting with
 * the `@@` header). Same shape consumed by the auto-update flow when it has
 * to substitute one hunk's patch for another.
 */
function extractHunksFromPatch(patch: string): Array<{ startLine: number; endLine: number; patch: string }> {
	const HEADER_RE = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/;
	const out: Array<{ startLine: number; endLine: number; patch: string }> = [];
	const lines = patch.split('\n');
	let pendingHeader: { startLine: number; endLine: number; headerIdx: number } | null = null;
	const flush = (endIdx: number) => {
		if (!pendingHeader) return;
		out.push({
			startLine: pendingHeader.startLine,
			endLine: pendingHeader.endLine,
			patch: lines.slice(pendingHeader.headerIdx, endIdx).join('\n'),
		});
		pendingHeader = null;
	};
	for (let i = 0; i < lines.length; i++) {
		const m = HEADER_RE.exec(lines[i]);
		if (m) {
			flush(i);
			const start = parseInt(m[1], 10);
			const count = m[2] !== undefined ? parseInt(m[2], 10) : 1;
			pendingHeader = { startLine: start, endLine: start + Math.max(count, 1) - 1, headerIdx: i };
		}
	}
	flush(lines.length);
	return out;
}

/**
 * Drift detection: identify tour hunks whose underlying file has changed since
 * the tour was authored. Returns a Set of *node IDs* (not hunk keys) so two
 * copies of the same underlying hunk in different sections each get their own
 * badge.
 *
 * A hunk is "outdated" when:
 *   - it has a `baseBlob` (legacy/migrated hunks without one stay "unknown"
 *     and are never flagged), AND
 *   - the current PR has a blob SHA for the same file (or its rename target), AND
 *   - the two SHAs differ.
 *
 * Short-circuit: when the tour's stored `headSha` matches the PR's current
 * `currentHeadSha`, no commit has landed since author time, so nothing can
 * have drifted - return an empty set without walking the hunks.
 *
 * Pin state is *not* consulted here. The banner-level "is the tour outdated"
 * check is `outdatedHunkIds.has(n.id) && !n.hunk.pinned`. Keeping pin out of
 * detection means the per-hunk "Outdated" / "History (Pinned)" badge can be
 * rendered uniformly regardless of pin state.
 */
export function computeOutdatedHunks(
	doc: CodeTourDocument,
	prState: PrState | undefined,
	indexed?: PrStateIndex,
): Set<string> {
	const out = new Set<string>();
	if (!prState || !prState.currentHeadSha) {
		return out;
	}
	if (doc.headSha && doc.headSha === prState.currentHeadSha) {
		// No drift possible - PR head hasn't moved since the tour was authored.
		return out;
	}
	const idx = indexed ?? indexPrState(prState);
	const resolveFile = (hunk: HunkReference): string | undefined => {
		// Try the new-side path first; fall back to the rename target if the
		// hunk's stored `file` is the *old* path of a file the PR has since
		// renamed; then try the hunk's own previousFile.
		if (idx.blobsByFile.has(hunk.file)) {
			return hunk.file;
		}
		const renamedTo = idx.renamedFrom.get(hunk.file);
		if (renamedTo !== undefined && idx.blobsByFile.has(renamedTo)) {
			return renamedTo;
		}
		if (hunk.previousFile && idx.blobsByFile.has(hunk.previousFile)) {
			return hunk.previousFile;
		}
		return undefined;
	};
	for (const node of flattenHunks(doc)) {
		if (!node.hunk.baseBlob) {
			continue; // unknown - can't compare
		}
		const currentFile = resolveFile(node.hunk);
		if (currentFile === undefined) {
			continue; // unknown - file not in PR diff
		}
		const currentBlob = idx.blobsByFile.get(currentFile);
		if (currentBlob === undefined) {
			continue;
		}
		if (currentBlob === node.hunk.baseBlob) {
			continue; // file unchanged - definitely fresh
		}
		// File changed - but did THIS hunk's edit change? If the hunk's stored
		// add/remove content matches some current PR hunk's add/remove content,
		// only the surrounding file shifted and this hunk is semantically
		// unchanged. Don't flag.
		const hunkFingerprint = editContentFingerprint(node.hunk.patch);
		if (hunkFingerprint !== undefined) {
			const fileFingerprints = idx.editFingerprintsByFile.get(currentFile);
			if (fileFingerprints && fileFingerprints.has(hunkFingerprint)) {
				continue;
			}
		}
		out.add(node.id);
	}
	return out;
}

/**
 * Pull the old-side line range out of a unified-diff `@@` header. The old-side
 * range is the pair `(-A, ,B)` - i.e. the lines on the base/merge-base side of
 * the diff. This range is stable across new-side shifts (adding/removing lines
 * elsewhere in the file moves the new-side range but the old-side stays the
 * same as long as the merge base doesn't move), so it's the strongest signal
 * for "is this the same logical hunk that drifted?" matching.
 *
 * Returns undefined when the patch is missing or doesn't start with a
 * recognizable `@@` header.
 */
function extractOldSideRange(patch: string | undefined): { oldStart: number; oldEnd: number } | undefined {
	if (!patch) {
		return undefined;
	}
	for (const line of patch.split('\n')) {
		const m = /^@@\s+-(\d+)(?:,(\d+))?\s+/.exec(line);
		if (m) {
			const oldStart = parseInt(m[1], 10);
			const oldCount = m[2] !== undefined ? parseInt(m[2], 10) : 1;
			return { oldStart, oldEnd: oldStart + Math.max(oldCount, 1) - 1 };
		}
	}
	return undefined;
}

/**
 * Score how likely each candidate PR hunk is the "right" replacement for an
 * outdated tour hunk, and return the index of the best match (or undefined
 * when no candidate has any signal of overlap).
 *
 * Primary signal: old-side range overlap (weighted heavily). When the merge
 * base hasn't moved, the hunk that edited the same source lines retains its
 * old-side range; this typically pins the answer immediately.
 *
 * Tiebreaker: new-side range overlap. Helps after a rebase moves the merge
 * base and old-side ranges no longer align.
 *
 * No suggestion (undefined) when nothing overlaps - the picker is then a
 * pure list of equal candidates and the author chooses.
 */
export function suggestUpdateCandidateIdx(
	tourHunk: { startLine: number; endLine: number; patch?: string },
	candidates: Array<{ startLine: number; endLine: number; patch: string }>,
): number | undefined {
	if (candidates.length === 0) {
		return undefined;
	}
	if (candidates.length === 1) {
		return 0;
	}
	const tourOld = extractOldSideRange(tourHunk.patch);
	let bestIdx = -1;
	let bestScore = 0;
	candidates.forEach((c, idx) => {
		let score = 0;
		if (tourOld) {
			const cOld = extractOldSideRange(c.patch);
			if (cOld) {
				const ovStart = Math.max(tourOld.oldStart, cOld.oldStart);
				const ovEnd = Math.min(tourOld.oldEnd, cOld.oldEnd);
				if (ovEnd >= ovStart) {
					// Heavy weight so any old-side overlap dominates the tiebreaker.
					score += (ovEnd - ovStart + 1) * 1000;
				}
			}
		}
		const ovStart = Math.max(tourHunk.startLine, c.startLine);
		const ovEnd = Math.min(tourHunk.endLine, c.endLine);
		if (ovEnd >= ovStart) {
			score += (ovEnd - ovStart + 1);
		}
		if (score > bestScore) {
			bestScore = score;
			bestIdx = idx;
		}
	});
	return bestIdx >= 0 ? bestIdx : undefined;
}

/**
 * Find hunks whose edit content is unchanged but whose line numbers (or full
 * patch text, due to surrounding context shifting) no longer match the
 * current PR. The detector treats these as "fresh" (not outdated), but the
 * stored line range and patch header are stale - the editor refreshes them
 * silently so other line-aware features (open-in-file, hunk navigation,
 * SHA badges) stay accurate.
 *
 * Returns one entry per hunk that needs refreshing. Pinned hunks are skipped:
 * the author has explicitly chosen to keep the historical state, line numbers
 * included.
 */
export interface ShiftOnlyUpdate {
	nodeId: string;
	newStartLine: number;
	newEndLine: number;
	newPatch: string;
	newBaseBlob: string;
}

export function findShiftOnlyMatches(
	doc: CodeTourDocument,
	prState: PrState | undefined,
	indexed?: PrStateIndex,
): ShiftOnlyUpdate[] {
	const out: ShiftOnlyUpdate[] = [];
	if (!prState?.currentHeadSha) {
		return out;
	}
	if (doc.headSha && doc.headSha === prState.currentHeadSha) {
		return out; // nothing in the PR has moved
	}
	const idx = indexed ?? indexPrState(prState);
	for (const node of flattenHunks(doc)) {
		if (node.hunk.pinned) {
			continue; // intentional historical record
		}
		if (!node.hunk.baseBlob) {
			continue; // can't tell if this is a shift or real drift
		}
		// Resolve the file as it's known in the current PR (with rename fallback).
		let currentFile = node.hunk.file;
		if (!idx.blobsByFile.has(currentFile)) {
			const renamedTo = idx.renamedFrom.get(node.hunk.file);
			if (renamedTo) {
				currentFile = renamedTo;
			} else if (node.hunk.previousFile && idx.blobsByFile.has(node.hunk.previousFile)) {
				currentFile = node.hunk.previousFile;
			} else {
				continue;
			}
		}
		const currentBlob = idx.blobsByFile.get(currentFile);
		if (!currentBlob || currentBlob === node.hunk.baseBlob) {
			continue; // file unchanged - nothing to refresh
		}
		const hunkFp = editContentFingerprint(node.hunk.patch);
		if (!hunkFp) {
			continue;
		}
		const candidates = idx.hunksByFile.get(currentFile);
		if (!candidates) {
			continue;
		}
		const match = candidates.find(c => editContentFingerprint(c.patch) === hunkFp);
		if (!match) {
			continue; // not a shift-only case - this is real drift
		}
		// Only emit an update when something actually differs.
		if (
			match.startLine === node.hunk.startLine
			&& match.endLine === node.hunk.endLine
			&& match.patch === node.hunk.patch
			&& currentBlob === node.hunk.baseBlob
		) {
			continue;
		}
		out.push({
			nodeId: node.id,
			newStartLine: match.startLine,
			newEndLine: match.endLine,
			newPatch: match.patch,
			newBaseBlob: currentBlob,
		});
	}
	return out;
}

/**
 * Coverage detection: count hunks present in the current PR diff that no tour
 * hunk corresponds to. Used by the banner's "M new in PR" indicator and by
 * the link that scrolls the changes pane to the first uncovered hunk.
 *
 * Independent of drift detection - new-in-PR hunks contribute to the count
 * but do NOT by themselves "outdate" the tour (an authored tour with no drift
 * but missing recent additions is incomplete, not stale).
 *
 * Pinned hunks are *historical context* - the author has explicitly told the
 * tour to keep the old patch visible after the file changed. They should not
 * count as covering the current PR's hunk at that location, otherwise an
 * author who pins a stale version sees the tour as 100% covered while the new
 * version is actually missing. Pinned hunks are skipped when building the
 * "covered" set.
 */
export function computeNewInPrCount(
	doc: CodeTourDocument,
	prState: PrState | undefined,
	indexed?: PrStateIndex,
): { count: number; missing: Array<{ file: string; startLine: number; endLine: number }> } {
	const empty = { count: 0, missing: [] as Array<{ file: string; startLine: number; endLine: number }> };
	if (!prState?.files) {
		return empty;
	}
	const idx = indexed ?? indexPrState(prState);
	// Coverage is by *edit content*, not by line range. A hunk whose patch
	// content matches a current PR hunk's patch content covers that current
	// hunk even if its line numbers have shifted due to unrelated edits
	// elsewhere in the file.
	const coveredFpsByFile = new Map<string, Set<string>>();
	const addCovered = (file: string, fp: string) => {
		let s = coveredFpsByFile.get(file);
		if (!s) { s = new Set(); coveredFpsByFile.set(file, s); }
		s.add(fp);
	};
	for (const node of flattenHunks(doc)) {
		if (node.hunk.pinned) {
			continue; // historical record - does not cover the current PR state
		}
		const fp = editContentFingerprint(node.hunk.patch);
		if (fp === undefined) {
			continue;
		}
		addCovered(node.hunk.file, fp);
		if (node.hunk.previousFile) {
			addCovered(node.hunk.previousFile, fp);
		}
		// Also cover by the rename target so a tour hunk recorded against the
		// old path covers a PR hunk now reported against the new path.
		const renamedTo = idx.renamedFrom.get(node.hunk.file);
		if (renamedTo) {
			addCovered(renamedTo, fp);
		}
	}
	const missing: Array<{ file: string; startLine: number; endLine: number }> = [];
	for (const [file, hunks] of idx.hunksByFile) {
		const coveredFps = coveredFpsByFile.get(file);
		for (const h of hunks) {
			const fp = editContentFingerprint(h.patch);
			if (fp !== undefined && coveredFps && coveredFps.has(fp)) {
				continue;
			}
			missing.push({ file, startLine: h.startLine, endLine: h.endLine });
		}
	}
	return { count: missing.length, missing };
}

export function flattenHunks(doc: CodeTourDocument): TourHunkNode[] {
	const out: TourHunkNode[] = [];
	const walk = (nodes: TourNode[]) => {
		for (const n of nodes) {
			if (n.type === 'hunk') {
				out.push(n);
			} else if (n.type === 'group') {
				walk(n.children);
			}
		}
	};
	walk(doc.children);
	return out;
}

export function hunksForSection(group: TourGroupNode): TourHunkNode[] {
	const out: TourHunkNode[] = [];
	const walk = (nodes: TourNode[]) => {
		for (const n of nodes) {
			if (n.type === 'hunk') {
				out.push(n);
			} else if (n.type === 'group') {
				walk(n.children);
			}
		}
	};
	walk(group.children);
	return out;
}

/**
 * Stable key for a hunk reference. Used as both the dedup key for the right pane
 * and the persistence key for mark-as-viewed state. Stable across edits to the
 * tour markdown because it only depends on the underlying file/line triple,
 * not on node ids (which `parseCodeTourMarkdown` regenerates on each parse).
 */
export function hunkKeyFor(hunk: HunkReference): string {
	return `${hunk.file}|${hunk.startLine}|${hunk.endLine}`;
}

function hunkKey(n: TourHunkNode): string {
	return hunkKeyFor(n.hunk);
}

export function dedupAndGroupByFile(hunks: TourHunkNode[]): FileHunkGroup[] {
	const seenKeys = new Set<string>();
	const fileOrder: string[] = [];
	const byFile = new Map<string, TourHunkNode[]>();
	for (const n of hunks) {
		const key = hunkKey(n);
		if (seenKeys.has(key)) {
			continue;
		}
		seenKeys.add(key);
		const f = n.hunk.file;
		if (!byFile.has(f)) {
			byFile.set(f, []);
			fileOrder.push(f);
		}
		byFile.get(f)!.push(n);
	}
	return fileOrder.map(file => ({
		file,
		hunks: [...byFile.get(file)!].sort((a, b) => a.hunk.startLine - b.hunk.startLine),
	}));
}

export function findNode(doc: CodeTourDocument, nodeId: string): TourNode | undefined {
	const walk = (nodes: TourNode[]): TourNode | undefined => {
		for (const n of nodes) {
			if (n.id === nodeId) {
				return n;
			}
			if (n.type === 'group') {
				const found = walk(n.children);
				if (found) {
					return found;
				}
			}
		}
		return undefined;
	};
	return walk(doc.children);
}

export function findParentGroup(doc: CodeTourDocument, nodeId: string): TourGroupNode | undefined {
	let result: TourGroupNode | undefined;
	const walk = (parent: TourGroupNode | undefined, nodes: TourNode[]) => {
		for (const n of nodes) {
			if (n.id === nodeId) {
				result = parent;
				return true;
			}
			if (n.type === 'group') {
				if (walk(n, n.children)) {
					return true;
				}
			}
		}
		return false;
	};
	walk(undefined, doc.children);
	return result;
}

/**
 * Unique descendant-hunk keys for a section. Used for the cascade toggle
 * (mark/unmark all in one shot) and for computing fully/partially-viewed.
 */
export function descendantHunkKeys(group: TourGroupNode): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const n of hunksForSection(group)) {
		const k = hunkKey(n);
		if (!seen.has(k)) {
			seen.add(k);
			out.push(k);
		}
	}
	return out;
}

/**
 * Section is fully viewed when every unique descendant hunk key is in the
 * viewed set. Vacuously true for sections with no descendant hunks (but the
 * UI hides the checkbox in that case, so this never matters in practice).
 */
export function isSectionFullyViewed(group: TourGroupNode, viewedKeys: Set<string>): boolean {
	const keys = descendantHunkKeys(group);
	if (keys.length === 0) {
		return false;
	}
	return keys.every(k => viewedKeys.has(k));
}

/**
 * Section is partially viewed when at least one descendant hunk is viewed
 * but not all. Used to drive the tri-state checkbox's `indeterminate` flag.
 */
export function isSectionPartiallyViewed(group: TourGroupNode, viewedKeys: Set<string>): boolean {
	const keys = descendantHunkKeys(group);
	if (keys.length === 0) {
		return false;
	}
	let any = false;
	let all = true;
	for (const k of keys) {
		if (viewedKeys.has(k)) {
			any = true;
		} else {
			all = false;
		}
	}
	return any && !all;
}

/**
 * Hunks "associated with" a text node = the contiguous run of hunk siblings
 * that immediately follow the text node in its parent's children list,
 * stopping at the first non-hunk sibling.
 */
export function associatedHunkIds(parent: TourGroupNode | undefined, doc: CodeTourDocument, textNodeId: string): Set<string> {
	const out = new Set<string>();
	const siblings = parent ? parent.children : doc.children;
	const idx = siblings.findIndex(n => n.id === textNodeId);
	if (idx < 0) {
		return out;
	}
	for (let i = idx + 1; i < siblings.length; i++) {
		const sib = siblings[i];
		if (sib.type === 'hunk') {
			out.add(sib.id);
		} else {
			break;
		}
	}
	return out;
}
