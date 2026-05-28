/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type {
	CodeTourDocument,
	TourGroupNode,
	TourHunkNode,
	TourNode,
} from '../../src/github/codeTourMarkdown';

export interface FileHunkGroup {
	file: string;
	hunks: TourHunkNode[];
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

function hunkKey(n: TourHunkNode): string {
	const h = n.hunk;
	return `${h.file}|${h.startLine}|${h.endLine}|${h.ref}`;
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
