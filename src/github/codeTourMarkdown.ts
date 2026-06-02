/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

/**
 * Represents a diff hunk reference embedded in a Change Tour document.
 *
 * On disk a hunk is a `<details>` block that GitHub (and other standard
 * markdown viewers) renders as a collapsible syntax-highlighted diff:
 *
 *   <details open>
 *   <summary><code>src/api.ts</code> · Refactor handler</summary>
 *
 *   <!-- changetour:hunk file="src/api.ts" highlights="new:14-18" baseBlob="89ab…" -->
 *
 *   ```diff
 *   @@ -A,B +C,D @@
 *   …patch body…
 *   ```
 *
 *   </details>
 *
 * The visible `<summary>` is computed from (file, previousFile, summary) at
 * serialize time; the canonical machine-readable metadata lives in the
 * `<!-- changetour:hunk … -->` comment. The `<details>` `open` attribute
 * controls default-collapse. The new-side line range is derived from the
 * patch body's first `@@ -A,B +C,D @@` header at load time.
 */
export interface HighlightRange {
	side: 'old' | 'new';
	start: number;
	end: number;
}

export interface HunkReference {
	file: string;
	startLine: number;
	endLine: number;
	patch?: string;
	previousFile?: string;
	highlights?: HighlightRange[];
	/** When true, viewers open the tour with this hunk pre-collapsed (override-able). */
	defaultCollapsed?: boolean;
	/**
	 * One-line natural-language description shown inline in the hunk header
	 * (both edit and viewer modes). When empty, the displayed text falls back
	 * to the first changed line of the patch; in edit mode the editor is
	 * pre-filled with that auto-default so authors can directly edit it.
	 */
	summary?: string;
	/**
	 * Git blob SHA of the new-side file at the tour-author `headSha`. Together
	 * with the tour-level `headSha` this lets a future update flow detect
	 * outdated hunks: re-fetch the current blob SHA for `file`; mismatch =>
	 * the underlying code has drifted from what this hunk shows.
	 */
	baseBlob?: string;
	/**
	 * When true, the outdated-hunk detector silences this hunk: even if the
	 * underlying file has drifted from `baseBlob`, the hunk does not contribute
	 * to the tour-level "outdated" banner. The badge still renders as
	 * "History (Pinned)" so readers can tell the stale state is intentional.
	 * Set via the editor's pin button; preserved verbatim by the LLM tools.
	 */
	pinned?: boolean;
}

const SUMMARY_PREVIEW_MAX_LEN = 60;

/**
 * Resolve the summary text shown alongside a hunk's diff header.
 *
 * If the hunk has an authored `summary`, return it with `isAuto: false`.
 * Otherwise default to the first changed line of the patch (truncated).
 * For patches with no add/delete lines, fall back to the thin `L{start}-{end}`
 * label. The auto-default is what populates the editor when the author
 * hasn't yet written their own one-line description - they can edit it
 * directly to author their summary.
 */
export function getHunkSummary(hunk: HunkReference): { text: string; isAuto: boolean } {
	const authored = hunk.summary?.trim();
	if (authored) {
		return { text: authored, isAuto: false };
	}
	if (hunk.patch) {
		// Scan the patch directly for the first add/delete line rather than
		// pulling in the full ParsedDiffLine pipeline - this helper runs from
		// both webview and extension code, so the dependency surface needs to
		// stay tiny.
		for (const line of hunk.patch.split('\n')) {
			if (line.startsWith('@@') || line.length === 0) {
				continue;
			}
			if (line.startsWith('+') || line.startsWith('-')) {
				const content = line.substring(1).trim();
				if (content.length > 0) {
					const text = content.length <= SUMMARY_PREVIEW_MAX_LEN
						? content
						: content.substring(0, SUMMARY_PREVIEW_MAX_LEN - 1).trimEnd() + '…';
					return { text, isAuto: true };
				}
			}
		}
	}
	return { text: `L${hunk.startLine}-${hunk.endLine}`, isAuto: true };
}

/**
 * Parse a `highlights=` attribute value (e.g. `new:14-18,old:22-25,new:30`)
 * into a list of HighlightRange. Malformed entries are silently dropped.
 */
export function parseHighlightAttribute(value: string | undefined): HighlightRange[] | undefined {
	if (!value) {
		return undefined;
	}
	const ranges: HighlightRange[] = [];
	for (const entry of value.split(',')) {
		const m = /^(old|new):(\d+)(?:-(\d+))?$/.exec(entry.trim());
		if (!m) {
			continue;
		}
		const start = parseInt(m[2], 10);
		const end = m[3] ? parseInt(m[3], 10) : start;
		ranges.push({
			side: m[1] as 'old' | 'new',
			start: Math.min(start, end),
			end: Math.max(start, end),
		});
	}
	return ranges.length ? ranges : undefined;
}

/**
 * Serialize a list of HighlightRange into the `highlights=` attribute value,
 * coalescing adjacent or overlapping ranges on the same side. Returns
 * undefined when there's nothing to write.
 */
export function serializeHighlightAttribute(highlights: HighlightRange[] | undefined): string | undefined {
	if (!highlights || highlights.length === 0) {
		return undefined;
	}
	const parts: string[] = [];
	for (const side of ['new', 'old'] as const) {
		const sorted = highlights.filter(r => r.side === side).sort((a, b) => a.start - b.start);
		const merged: HighlightRange[] = [];
		for (const r of sorted) {
			const last = merged[merged.length - 1];
			if (last && r.start <= last.end + 1) {
				last.end = Math.max(last.end, r.end);
			} else {
				merged.push({ side, start: r.start, end: r.end });
			}
		}
		for (const r of merged) {
			parts.push(r.start === r.end ? `${side}:${r.start}` : `${side}:${r.start}-${r.end}`);
		}
	}
	return parts.length ? parts.join(',') : undefined;
}

export type TourNodeType = 'group' | 'text' | 'hunk';

export interface TourGroupNode {
	type: 'group';
	id: string;
	title: string;
	level: number;
	children: TourNode[];
	/** When true, viewers open the tour with this section pre-collapsed (override-able). */
	defaultCollapsed?: boolean;
	/** 1-indexed line in the source markdown where the heading sits. */
	sourceStartLine?: number;
	/** 1-indexed line in the source markdown - same as start for groups (header line only). */
	sourceEndLine?: number;
}

export interface TourTextNode {
	type: 'text';
	id: string;
	content: string;
	/** 1-indexed first line of the paragraph's content in the source markdown. */
	sourceStartLine?: number;
	/** 1-indexed last line of the paragraph's content in the source markdown. */
	sourceEndLine?: number;
}

export interface TourHunkNode {
	type: 'hunk';
	id: string;
	hunk: HunkReference;
}

export type TourNode = TourGroupNode | TourTextNode | TourHunkNode;

export interface CodeTourDocument {
	title: string;
	/** Format version. Currently always 1; bumps trigger an explicit migration. */
	schemaVersion?: number;
	prNumber?: number;
	prOwner?: string;
	prRepo?: string;
	isPR?: boolean;
	baseRef?: string;
	/** PR base commit SHA at tour-author time. Anchors the future update flow. */
	baseSha?: string;
	/** PR head commit SHA at tour-author time. Used together with per-hunk `baseBlob` to detect drift. */
	headSha?: string;
	children: TourNode[];
}

const DETAILS_OPEN_PATTERN = /^\s*<details(\s+open)?\s*>\s*$/;
const DETAILS_CLOSE_PATTERN = /^\s*<\/details>\s*$/;
const SUMMARY_LINE_PATTERN = /^\s*<summary>.*<\/summary>\s*$/;
const HUNK_METADATA_PATTERN = /^\s*<!--\s*changetour:hunk\s+(.*?)\s*-->\s*$/;
const DIFF_FENCE_OPEN_PATTERN = /^\s*```diff\s*$/;
const DIFF_FENCE_CLOSE_PATTERN = /^\s*```\s*$/;
const HUNK_BODY_RANGE_PATTERN = /^@@\s+-\d+(?:,\d+)?\s+\+(?<start>\d+)(?:,(?<count>\d+))?\s+@@/;
/** Legacy `:::hunk …` opener. Triggers a migration error on read. */
const LEGACY_HUNK_OPEN_PATTERN = /^:::hunk(\s|$)/;

interface HunkAttributes {
	file?: string;
	previousFile?: string;
	level?: string;
	highlights?: string;
	summary?: string;
	baseBlob?: string;
	pinned?: string;
}

/**
 * Tokenize the attribute list inside a `<!-- changetour:hunk … -->` comment.
 * Each attribute is `key=value`, separated by whitespace, in any order. All
 * attributes are optional except `file`; the new-side line range is always
 * derived from the patch body's `@@` header.
 *
 * Values can be either bare tokens (`file=path/to/x.ts`) or double-quoted
 * strings (`summary="My description with spaces"`). Inside a quoted value,
 * `\"` and `\\` are recognized as escapes for `"` and `\`.
 */
function parseHunkAttributes(attributeList: string): HunkAttributes {
	const out: HunkAttributes = {};
	const re = /(\w+)=(?:"((?:\\.|[^"\\])*)"|([^\s]+))/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(attributeList)) !== null) {
		const key = m[1] as keyof HunkAttributes;
		const value = m[2] !== undefined ? m[2].replace(/\\(["\\])/g, '$1') : m[3];
		out[key] = value;
	}
	return out;
}

/**
 * Serialize a value for use in the metadata comment attribute list. Bare
 * tokens (no whitespace, no quote) are emitted as-is; anything else is wrapped
 * in double quotes with `\` and `"` escaped.
 */
function serializeHunkAttributeValue(value: string): string {
	if (value.length > 0 && !/[\s"\\]/.test(value)) {
		return value;
	}
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * HTML-escape a string for embedding inside a `<summary>` element. The
 * `<summary>` is purely for human display; the canonical machine-readable
 * metadata lives in the adjacent `<!-- changetour:hunk … -->` comment.
 */
function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Build the full `<details>` block for a hunk, including the visible
 * `<summary>`, the metadata comment, and the fenced ```diff body. Shared
 * between `serializeCodeTourMarkdown`, `createHunkBlock`, and the webview's
 * local serializer in `codeTourEditor.tsx` (which mirrors this one).
 *
 * `level` is stamped into the metadata comment as an opaque round-trip aid
 * so the parser can pop the group stack correctly when a hunk sits at a
 * shallower nesting than its predecessor.
 */
export function buildHunkBlock(hunk: HunkReference, level?: number): string {
	const lines: string[] = [];

	lines.push(hunk.defaultCollapsed ? '<details>' : '<details open>');

	// `<summary>` is the human-visible header: `<code>file</code> · summary`
	// (or `<code>previousFile</code> → <code>file</code> · summary` for renames).
	const summaryText = getHunkSummary(hunk).text;
	const pathHtml = hunk.previousFile && hunk.previousFile !== hunk.file
		? `<code>${escapeHtml(hunk.previousFile)}</code> → <code>${escapeHtml(hunk.file)}</code>`
		: `<code>${escapeHtml(hunk.file)}</code>`;
	lines.push(`<summary>${pathHtml} · ${escapeHtml(summaryText)}</summary>`);
	lines.push('');

	// Metadata comment - the canonical attribute store. Order is stable for
	// round-trip diffability.
	const attrs: string[] = [`file=${serializeHunkAttributeValue(hunk.file)}`];
	if (hunk.previousFile) attrs.push(`previousFile=${serializeHunkAttributeValue(hunk.previousFile)}`);
	if (level !== undefined) attrs.push(`level=${level}`);
	const highlightAttr = serializeHighlightAttribute(hunk.highlights);
	if (highlightAttr) attrs.push(`highlights=${highlightAttr}`);
	if (hunk.summary && hunk.summary.trim().length > 0) {
		attrs.push(`summary=${serializeHunkAttributeValue(hunk.summary)}`);
	}
	if (hunk.baseBlob) attrs.push(`baseBlob=${serializeHunkAttributeValue(hunk.baseBlob)}`);
	if (hunk.pinned) attrs.push(`pinned=true`);
	lines.push(`<!-- changetour:hunk ${attrs.join(' ')} -->`);
	lines.push('');

	lines.push('```diff');
	if (hunk.patch) {
		lines.push(hunk.patch);
	}
	lines.push('```');
	lines.push('');
	lines.push('</details>');

	return lines.join('\n');
}

/**
 * Read the new-side line range from the first `@@ -A,B +C,D @@` line of a
 * patch body. Returns `undefined` if no such line is found.
 */
function extractLineRangeFromPatch(patch: string | undefined): { startLine: number; endLine: number } | undefined {
	if (!patch) {
		return undefined;
	}
	for (const line of patch.split('\n')) {
		const m = HUNK_BODY_RANGE_PATTERN.exec(line);
		if (m) {
			const start = parseInt(m.groups!.start, 10);
			const count = m.groups!.count !== undefined ? parseInt(m.groups!.count, 10) : 1;
			return { startLine: start, endLine: start + Math.max(count, 1) - 1 };
		}
	}
	return undefined;
}

let nextId = 0;
function genId(): string {
	return `node-${nextId++}`;
}

export function resetIdCounter(): void {
	nextId = 0;
}

/**
 * Try to consume a `<details>`-wrapped hunk block starting at `lines[startIdx]`.
 * Returns null if the lines don't match the canonical shape, in which case
 * the caller should fall back to treating `lines[startIdx]` as text (the
 * `<details>` tag might be authored prose, not a hunk).
 *
 * The canonical shape (with optional blank lines between each element):
 *
 *   <details> | <details open>
 *   <summary>…</summary>
 *
 *   <!-- changetour:hunk file="…" … -->
 *
 *   ```diff
 *   …patch…
 *   ```
 *
 *   </details>
 */
function tryParseHunkBlock(
	lines: string[],
	startIdx: number,
): { hunk: HunkReference; level?: number; nextIdx: number } | null {
	const openMatch = DETAILS_OPEN_PATTERN.exec(lines[startIdx]);
	if (!openMatch) {
		return null;
	}
	const isOpen = !!openMatch[1]; // matched `<details open>`
	let i = startIdx + 1;
	const skipBlanks = () => {
		while (i < lines.length && lines[i].trim() === '') i++;
	};

	skipBlanks();
	if (i >= lines.length || !SUMMARY_LINE_PATTERN.test(lines[i])) {
		return null;
	}
	i++;

	skipBlanks();
	if (i >= lines.length) {
		return null;
	}
	const metaMatch = HUNK_METADATA_PATTERN.exec(lines[i]);
	if (!metaMatch) {
		return null;
	}
	const attrs = parseHunkAttributes(metaMatch[1]);
	if (!attrs.file) {
		return null;
	}
	i++;

	skipBlanks();
	if (i >= lines.length || !DIFF_FENCE_OPEN_PATTERN.test(lines[i])) {
		return null;
	}
	i++;

	const patchLines: string[] = [];
	while (i < lines.length && !DIFF_FENCE_CLOSE_PATTERN.test(lines[i])) {
		patchLines.push(lines[i]);
		i++;
	}
	if (i >= lines.length) {
		return null; // unclosed ```diff fence
	}
	i++; // consume closing ```

	skipBlanks();
	if (i >= lines.length || !DETAILS_CLOSE_PATTERN.test(lines[i])) {
		return null;
	}
	i++; // consume </details>

	const patch = patchLines.join('\n').trim();
	const range = extractLineRangeFromPatch(patch || undefined);
	const hunk: HunkReference = {
		file: attrs.file,
		startLine: range?.startLine ?? 0,
		endLine: range?.endLine ?? 0,
		patch: patch || undefined,
		previousFile: attrs.previousFile,
		highlights: parseHighlightAttribute(attrs.highlights),
		defaultCollapsed: isOpen ? undefined : true,
		summary: attrs.summary && attrs.summary.trim().length > 0 ? attrs.summary : undefined,
		baseBlob: attrs.baseBlob,
		pinned: attrs.pinned === 'true' ? true : undefined,
	};
	const level = attrs.level ? parseInt(attrs.level, 10) : undefined;
	return { hunk, level: Number.isFinite(level) ? level : undefined, nextIdx: i };
}

/**
 * Parse a `.changetour.md` file into a structured document tree.
 *
 * Rules:
 * - `# Title` (h1) becomes the document title
 * - `## …` / `### …` etc. become group nodes
 * - `<details>`-wrapped diff blocks (see `tryParseHunkBlock` and `buildHunkBlock`)
 *   become hunk references
 * - Legacy `:::hunk …` directives throw a migration error
 * - Everything else is aggregated into text nodes
 */
export function parseCodeTourMarkdown(text: string): CodeTourDocument {
	resetIdCounter();
	const lines = text.split('\n');

	let title = '';
	let schemaVersion: number | undefined;
	let prNumber: number | undefined;
	let prOwner: string | undefined;
	let prRepo: string | undefined;
	let isPR: boolean | undefined;
	let baseRef: string | undefined;
	let baseSha: string | undefined;
	let headSha: string | undefined;

	const rootChildren: TourNode[] = [];
	// Stack tracks the current nesting of groups - element 0 is shallowest.
	const groupStack: TourGroupNode[] = [];
	let pendingTextLines: string[] = [];
	let pendingTextStartLine: number | undefined;
	let pendingTextEndLine: number | undefined;

	let parseState: 'frontmatter-start' | 'frontmatter-body' | 'body' = 'frontmatter-start';

	function currentContainer(): TourNode[] {
		return groupStack.length > 0 ? groupStack[groupStack.length - 1].children : rootChildren;
	}

	function flushText(): void {
		if (pendingTextLines.length === 0) {
			return;
		}
		const content = pendingTextLines.join('\n');
		// Only add if there is actual non-whitespace content
		if (content.trim().length > 0) {
			currentContainer().push({
				type: 'text',
				id: genId(),
				content: content.trim(),
				sourceStartLine: pendingTextStartLine,
				sourceEndLine: pendingTextEndLine,
			});
		}
		pendingTextLines = [];
		pendingTextStartLine = undefined;
		pendingTextEndLine = undefined;
	}

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const lineNo = i + 1; // 1-indexed

		if (parseState === 'frontmatter-start') {
			if (line.trim() === '---') {
				parseState = 'frontmatter-body';
				i++;
				continue;
			}
			parseState = 'body';
		} else if (parseState === 'frontmatter-body') {
			if (line.trim() === '---') {
				parseState = 'body';
				i++;
				continue;
			}
			const match = /^([a-zA-Z0-9_]+)\s*:\s*(.+)$/.exec(line);
			if (match) {
				const key = match[1];
				const value = match[2].trim();
				if (key === 'schemaVersion') schemaVersion = parseInt(value, 10);
				else if (key === 'prNumber') prNumber = parseInt(value, 10);
				else if (key === 'prOwner') prOwner = value;
				else if (key === 'prRepo') prRepo = value;
				else if (key === 'isPR') isPR = value === 'true';
				else if (key === 'baseRef') baseRef = value;
				else if (key === 'baseSha') baseSha = value;
				else if (key === 'headSha') headSha = value;
			}
			i++;
			continue;
		}

		// Reject legacy `:::hunk …` directives explicitly. Hard cutover: we
		// don't try to parse them - point the author at the migration script.
		if (LEGACY_HUNK_OPEN_PATTERN.test(line)) {
			throw new Error(
				`Line ${lineNo}: legacy ':::hunk' directive is no longer supported. ` +
				`Run \`node scripts/migrate-change-tour.js <path>\` to upgrade this tour to the new <details>-based format.`,
			);
		}

		// Detect headings
		const headingMatch = /^(?<hashes>#{1,6})\s+(?<text>.+)$/.exec(line);
		if (headingMatch) {
			const level = headingMatch.groups!.hashes.length;
			const headingText = headingMatch.groups!.text.trim();

			if (level === 1 && !title) {
				flushText();
				title = headingText;
				i++;
				continue;
			}

			flushText();

			while (groupStack.length > 0 && groupStack[groupStack.length - 1].level >= level) {
				groupStack.pop();
			}

			// Section authors can mark a section as collapsed-by-default with a
			// trailing HTML comment: `## My Section <!-- collapsed -->`. We strip
			// it from the title and stash the flag on the group; viewers seed
			// their initial collapsed-set from this but can still toggle it open.
			const trailingCollapsedMarker = /\s*<!--\s*collapsed\s*-->\s*$/;
			const defaultCollapsed = trailingCollapsedMarker.test(headingText);
			const cleanedTitle = defaultCollapsed
				? headingText.replace(trailingCollapsedMarker, '').trim()
				: headingText;

			const group: TourGroupNode = {
				type: 'group',
				id: genId(),
				title: cleanedTitle,
				level,
				children: [],
				sourceStartLine: lineNo,
				sourceEndLine: lineNo,
			};
			if (defaultCollapsed) {
				group.defaultCollapsed = true;
			}
			currentContainer().push(group);
			groupStack.push(group);
			i++;
			continue;
		}

		// Detect <details>-wrapped hunk blocks. Peek-ahead: if the structure
		// doesn't match, fall through and treat the `<details>` line as text
		// (authors might use `<details>` in their narration for other purposes).
		if (DETAILS_OPEN_PATTERN.test(line)) {
			const result = tryParseHunkBlock(lines, i);
			if (result) {
				flushText();

				// The level attribute (round-trip aid) tells us if this hunk
				// belongs at a shallower nesting than the deepest open group.
				if (result.level !== undefined) {
					while (groupStack.length > 0 && groupStack[groupStack.length - 1].level > result.level) {
						groupStack.pop();
					}
				}

				const hunkNode: TourHunkNode = {
					type: 'hunk',
					id: genId(),
					hunk: result.hunk,
				};
				currentContainer().push(hunkNode);
				i = result.nextIdx;
				continue;
			}
		}

		// Everything else is text. Track source lines only against non-blank lines,
		// so leading/trailing blank lines in `pendingTextLines` don't shift the
		// reported range (and the very first non-blank line still wins even when
		// blank lines have already been pushed).
		if (line.trim().length > 0) {
			if (pendingTextStartLine === undefined) {
				pendingTextStartLine = lineNo;
			}
			pendingTextEndLine = lineNo;
		}
		pendingTextLines.push(line);
		i++;
	}

	flushText();

	return {
		title: title || 'Untitled Change Tour',
		schemaVersion,
		prNumber,
		prOwner,
		prRepo,
		isPR,
		baseRef,
		baseSha,
		headSha,
		children: rootChildren,
	};
}

/**
 * Serialize a Change Tour document back into markdown text.
 */
export function serializeCodeTourMarkdown(doc: CodeTourDocument): string {
	const lines: string[] = [];

	const hasFrontmatter = doc.schemaVersion !== undefined
		|| doc.isPR !== undefined
		|| doc.prNumber !== undefined
		|| doc.prOwner
		|| doc.prRepo
		|| doc.baseRef
		|| doc.baseSha
		|| doc.headSha;
	if (hasFrontmatter) {
		lines.push('---');
		if (doc.schemaVersion !== undefined) lines.push(`schemaVersion: ${doc.schemaVersion}`);
		if (doc.isPR !== undefined) lines.push(`isPR: ${doc.isPR}`);
		if (doc.prNumber !== undefined) lines.push(`prNumber: ${doc.prNumber}`);
		if (doc.prOwner) lines.push(`prOwner: ${doc.prOwner}`);
		if (doc.prRepo) lines.push(`prRepo: ${doc.prRepo}`);
		if (doc.baseRef) lines.push(`baseRef: ${doc.baseRef}`);
		if (doc.baseSha) lines.push(`baseSha: ${doc.baseSha}`);
		if (doc.headSha) lines.push(`headSha: ${doc.headSha}`);
		lines.push('---');
	}

	lines.push(`# ${doc.title}`);
	lines.push('');

	function serializeNodes(nodes: TourNode[], currentLevel: number): void {
		for (const node of nodes) {
			switch (node.type) {
				case 'group': {
					const prefix = '#'.repeat(node.level);
					const suffix = node.defaultCollapsed ? ' <!-- collapsed -->' : '';
					lines.push(`${prefix} ${node.title}${suffix}`);
					lines.push('');
					serializeNodes(node.children, node.level);
					break;
				}
				case 'text':
					lines.push(node.content);
					lines.push('');
					break;
				case 'hunk': {
					lines.push(buildHunkBlock(node.hunk, currentLevel));
					lines.push('');
					break;
				}
			}
		}
	}

	serializeNodes(doc.children, 1);

	// Trim trailing newlines to a single trailing newline
	return lines.join('\n').replace(/\n+$/, '\n');
}

/**
 * Create a hunk block suitable for inserting into a document.
 */
export function createHunkBlock(hunk: HunkReference): string {
	return buildHunkBlock(hunk);
}
