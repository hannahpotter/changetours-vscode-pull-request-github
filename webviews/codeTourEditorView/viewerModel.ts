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
