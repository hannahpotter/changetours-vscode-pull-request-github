/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

/**
 * Represents a diff hunk reference embedded in a code tour document.
 * Stored in the markdown as a fenced block:
 *   :::hunk file=<path> lines=<start>-<end> ref=<commitish>
 *   <patch content>
 *   :::
 */
export interface HunkReference {
	file: string;
	startLine: number;
	endLine: number;
	ref: string;
	patch?: string;
}

export type TourNodeType = 'group' | 'text' | 'hunk';

export interface TourGroupNode {
	type: 'group';
	id: string;
	title: string;
	level: number;
	children: TourNode[];
}

export interface TourTextNode {
	type: 'text';
	id: string;
	content: string;
}

export interface TourHunkNode {
	type: 'hunk';
	id: string;
	hunk: HunkReference;
}

export type TourNode = TourGroupNode | TourTextNode | TourHunkNode;

export interface CodeTourDocument {
	title: string;
	children: TourNode[];
}

const HUNK_PATTERN = /^:::hunk\s+file=(?<file>\S+)\s+lines=(?<start>\d+)-(?<end>\d+)\s+ref=(?<ref>\S+)$/;
const HUNK_END_PATTERN = /^:::$/;

let nextId = 0;
function genId(): string {
	return `node-${nextId++}`;
}

export function resetIdCounter(): void {
	nextId = 0;
}

/**
 * Parse a `.codetour.md` file into a structured document tree.
 *
 * Rules:
 * - `# Title` (h1) becomes the document title
 * - `## …` / `### …` etc. become group nodes
 * - `:::hunk file=… lines=…-… ref=…:::` become hunk references
 * - Everything else is aggregated into text nodes
 */
export function parseCodeTourMarkdown(text: string): CodeTourDocument {
	resetIdCounter();
	const lines = text.split('\n');

	let title = '';
	const rootChildren: TourNode[] = [];
	// Stack tracks the current nesting of groups - element 0 is shallowest.
	const groupStack: TourGroupNode[] = [];
	let pendingTextLines: string[] = [];

	// State for multi-line hunk parsing
	let inHunk = false;
	let pendingHunk: { file: string; startLine: number; endLine: number; ref: string } | null = null;
	let pendingPatchLines: string[] = [];

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
			currentContainer().push({ type: 'text', id: genId(), content: content.trim() });
		}
		pendingTextLines = [];
	}

	function flushHunk(): void {
		if (!pendingHunk) {
			return;
		}
		const patch = pendingPatchLines.join('\n').trim();
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

	for (const line of lines) {
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

			const group: TourGroupNode = {
				type: 'group',
				id: genId(),
				title: headingText,
				level,
				children: [],
			};
			currentContainer().push(group);
			groupStack.push(group);
			continue;
		}

		// Detect hunk references
		const hunkMatch = HUNK_PATTERN.exec(line);
		if (hunkMatch) {
			flushText();

			// Multi-line hunk, start accumulating patch content
			inHunk = true;
			pendingHunk = {
				file: hunkMatch.groups!.file,
				startLine: parseInt(hunkMatch.groups!.start, 10),
				endLine: parseInt(hunkMatch.groups!.end, 10),
				ref: hunkMatch.groups!.ref,
			};
			pendingPatchLines = [];
			continue;
		}

		// Everything else is text
		pendingTextLines.push(line);
	}

	flushText();
	// Handle unclosed hunk at end of file
	if (inHunk) {
		flushHunk();
	}

	return { title: title || 'Untitled Code Tour', children: rootChildren };
}

/**
 * Serialize a CodeTourDocument back into markdown text.
 */
export function serializeCodeTourMarkdown(doc: CodeTourDocument): string {
	const lines: string[] = [];
	lines.push(`# ${doc.title}`);
	lines.push('');

	function serializeNodes(nodes: TourNode[]): void {
		for (const node of nodes) {
			switch (node.type) {
				case 'group': {
					const prefix = '#'.repeat(node.level);
					lines.push(`${prefix} ${node.title}`);
					lines.push('');
					serializeNodes(node.children);
					break;
				}
				case 'text':
					lines.push(node.content);
					lines.push('');
					break;
				case 'hunk':
					lines.push(`:::hunk file=${node.hunk.file} lines=${node.hunk.startLine}-${node.hunk.endLine} ref=${node.hunk.ref}`);
					if (node.hunk.patch) {
						lines.push(node.hunk.patch);
					}
					lines.push(':::');
					lines.push('');
					break;
			}
		}
	}

	serializeNodes(doc.children);

	// Trim trailing newlines to a single trailing newline
	return lines.join('\n').replace(/\n+$/, '\n');
}

/**
 * Create a hunk directive string suitable for inserting into a document.
 */
export function createHunkDirective(hunk: HunkReference): string {
	const header = `:::hunk file=${hunk.file} lines=${hunk.startLine}-${hunk.endLine} ref=${hunk.ref}`;
	if (hunk.patch) {
		return `${header}\n${hunk.patch}\n:::`;
	}
	return `${header}\n:::`;
}
