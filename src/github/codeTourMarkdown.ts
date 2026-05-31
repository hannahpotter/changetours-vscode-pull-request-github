/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

/**
 * Represents a diff hunk reference embedded in a Change Tour document.
 * Stored in the markdown as a fenced block:
 *   :::hunk file=<path> [previousFile=<old path>] [highlights=…]
 *   <patch content starting with the @@ -A,B +C,D @@ header>
 *   :::
 *
 * The new-side line range is derived from the patch body's @@ header at load
 * time; older files with explicit `lines=<start>-<end>` and `ref=<commitish>`
 * attributes are still accepted for backward compatibility.
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
	ref: string;
	patch?: string;
	previousFile?: string;
	highlights?: HighlightRange[];
	/** When true, viewers open the tour with this hunk pre-collapsed (override-able). */
	defaultCollapsed?: boolean;
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
	prNumber?: number;
	prOwner?: string;
	prRepo?: string;
	isPR?: boolean;
	baseRef?: string;
	children: TourNode[];
}

const HUNK_OPEN_PATTERN = /^:::hunk\s+(.+?)\s*$/;
const HUNK_END_PATTERN = /^:::$/;
const HUNK_BODY_RANGE_PATTERN = /^@@\s+-\d+(?:,\d+)?\s+\+(?<start>\d+)(?:,(?<count>\d+))?\s+@@/;

interface HunkAttributes {
	file?: string;
	lines?: string;
	ref?: string;
	previousFile?: string;
	level?: string;
	highlights?: string;
	defaultCollapsed?: string;
}

/**
 * Tokenize the attribute list of a `:::hunk` directive. Each attribute is
 * `key=value`, separated by whitespace, in any order. All attributes are
 * optional except `file`; missing line range and ref are derived later from
 * the patch body's `@@` header and frontmatter respectively.
 */
function parseHunkAttributes(attributeList: string): HunkAttributes {
	const out: HunkAttributes = {};
	const re = /(\w+)=([^\s]+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(attributeList)) !== null) {
		const key = m[1] as keyof HunkAttributes;
		out[key] = m[2];
	}
	return out;
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
 * Parse a `.changetour.md` file into a structured document tree.
 *
 * Rules:
 * - `# Title` (h1) becomes the document title
 * - `## …` / `### …` etc. become group nodes
 * - `:::hunk file=…` … `:::` blocks become hunk references
 * - Everything else is aggregated into text nodes
 */
export function parseCodeTourMarkdown(text: string): CodeTourDocument {
	resetIdCounter();
	const lines = text.split('\n');

	let title = '';
	let prNumber: number | undefined;
	let prOwner: string | undefined;
	let prRepo: string | undefined;
	let isPR: boolean | undefined;
	let baseRef: string | undefined;

	const rootChildren: TourNode[] = [];
	// Stack tracks the current nesting of groups - element 0 is shallowest.
	const groupStack: TourGroupNode[] = [];
	let pendingTextLines: string[] = [];
	let pendingTextStartLine: number | undefined;
	let pendingTextEndLine: number | undefined;

	// State for multi-line hunk parsing
	let inHunk = false;
	let pendingHunk: HunkReference | null = null;
	let pendingPatchLines: string[] = [];

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

	function flushHunk(): void {
		if (!pendingHunk) {
			return;
		}
		const patch = pendingPatchLines.join('\n').trim();
		// If the directive omitted `lines=` (the new format), derive the range
		// from the patch body's `@@ -A,B +C,D @@` header.
		if (!pendingHunk.startLine || !pendingHunk.endLine) {
			const range = extractLineRangeFromPatch(patch || undefined);
			if (range) {
				pendingHunk.startLine = range.startLine;
				pendingHunk.endLine = range.endLine;
			}
		}
		const hunkNode: TourHunkNode = {
			type: 'hunk',
			id: genId(),
			hunk: {
				...pendingHunk,
				patch: patch || undefined,
			},
		};
		currentContainer().push(hunkNode);
		pendingHunk = null;
		pendingPatchLines = [];
		inHunk = false;
	}

	let lineNo = 0;
	for (const line of lines) {
		lineNo++; // 1-indexed
		if (parseState === 'frontmatter-start') {
			if (line.trim() === '---') {
				parseState = 'frontmatter-body';
				continue;
			} else {
				parseState = 'body';
			}
		} else if (parseState === 'frontmatter-body') {
			if (line.trim() === '---') {
				parseState = 'body';
			} else {
				const match = /^([a-zA-Z0-9_]+)\s*:\s*(.+)$/.exec(line);
				if (match) {
					const key = match[1];
					const value = match[2].trim();
					if (key === 'prNumber') prNumber = parseInt(value, 10);
					else if (key === 'prOwner') prOwner = value;
					else if (key === 'prRepo') prRepo = value;
					else if (key === 'isPR') isPR = value === 'true';
					else if (key === 'baseRef') baseRef = value;
				}
			}
			continue;
		}

		// If we're inside a multi-line hunk, look for the closing :::
		if (inHunk) {
			if (HUNK_END_PATTERN.test(line)) {
				flushHunk();
			} else {
				pendingPatchLines.push(line);
			}
			continue;
		}

		// Detect headings
		const headingMatch = /^(?<hashes>#{1,6})\s+(?<text>.+)$/.exec(line);
		if (headingMatch) {
			const level = headingMatch.groups!.hashes.length;
			const headingText = headingMatch.groups!.text.trim();

			if (level === 1 && !title) {
				// Document title
				flushText();
				title = headingText;
				continue;
			}

			// Heading of level 2+ defines a group
			flushText();

			// Pop groups that are at the same level or deeper
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
			continue;
		}

		// Detect hunk references
		const hunkOpenMatch = HUNK_OPEN_PATTERN.exec(line);
		if (hunkOpenMatch) {
			const attrs = parseHunkAttributes(hunkOpenMatch[1]);
			if (attrs.file) {
				flushText();

				if (attrs.level) {
					const parsedLevel = parseInt(attrs.level, 10);
					while (groupStack.length > 0 && groupStack[groupStack.length - 1].level > parsedLevel) {
						groupStack.pop();
					}
				}

				let startLine = 0;
				let endLine = 0;
				if (attrs.lines) {
					const m = /^(\d+)-(\d+)$/.exec(attrs.lines);
					if (m) {
						startLine = parseInt(m[1], 10);
						endLine = parseInt(m[2], 10);
					}
				}

				// Multi-line hunk, start accumulating patch content. Line range
				// is derived from the patch body at flushHunk() if not present here.
				inHunk = true;
				pendingHunk = {
					file: attrs.file,
					startLine,
					endLine,
					ref: attrs.ref ?? 'HEAD',
					previousFile: attrs.previousFile,
					highlights: parseHighlightAttribute(attrs.highlights),
					defaultCollapsed: attrs.defaultCollapsed === 'true' ? true : undefined,
				};
				pendingPatchLines = [];
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
	}

	flushText();
	// Handle unclosed hunk at end of file
	if (inHunk) {
		flushHunk();
	}

	return { title: title || 'Untitled Change Tour', prNumber, prOwner, prRepo, isPR, baseRef, children: rootChildren };
}

/**
 * Serialize a Change Tour document back into markdown text.
 */
export function serializeCodeTourMarkdown(doc: CodeTourDocument): string {
	const lines: string[] = [];

	if (doc.isPR !== undefined || doc.prNumber !== undefined || doc.prOwner || doc.prRepo || doc.baseRef) {
		lines.push('---');
		if (doc.isPR !== undefined) lines.push(`isPR: ${doc.isPR}`);
		if (doc.prNumber !== undefined) lines.push(`prNumber: ${doc.prNumber}`);
		if (doc.prOwner) lines.push(`prOwner: ${doc.prOwner}`);
		if (doc.prRepo) lines.push(`prRepo: ${doc.prRepo}`);
		if (doc.baseRef) lines.push(`baseRef: ${doc.baseRef}`);
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
					let hunkHeader = `:::hunk file=${node.hunk.file}`;
					if (node.hunk.previousFile) hunkHeader += ` previousFile=${node.hunk.previousFile}`;
					hunkHeader += ` level=${currentLevel}`;
					const highlightAttr = serializeHighlightAttribute(node.hunk.highlights);
					if (highlightAttr) hunkHeader += ` highlights=${highlightAttr}`;
					if (node.hunk.defaultCollapsed) hunkHeader += ` defaultCollapsed=true`;
					lines.push(hunkHeader);
					if (node.hunk.patch) {
						lines.push(node.hunk.patch);
					}
					lines.push(':::');
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
 * Create a hunk directive string suitable for inserting into a document.
 */
export function createHunkDirective(hunk: HunkReference): string {
	let header = `:::hunk file=${hunk.file}`;
	if (hunk.previousFile) header += ` previousFile=${hunk.previousFile}`;
	const highlightAttr = serializeHighlightAttribute(hunk.highlights);
	if (highlightAttr) header += ` highlights=${highlightAttr}`;
	if (hunk.defaultCollapsed) header += ` defaultCollapsed=true`;

	if (hunk.patch) {
		return `${header}\n${hunk.patch}\n:::`;
	}
	return `${header}\n:::`;
}
