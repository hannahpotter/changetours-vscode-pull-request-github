/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type DropPosition = 'before' | 'after';

/**
 * Generic constraint for nodes that can be manipulated by these utilities.
 * Works with TourNode, EditorNode, and similar hierarchical structures.
 */
export interface ManipulableNode {
	id: string;
	type: string;
	children?: ManipulableNode[]; // Added to avoid casting to 'any'
}

export function extractNodeById<T extends ManipulableNode>(
	nodes: T[],
	nodeId: string,
): { nodes: T[]; extracted?: T } {
	let extracted: T | undefined;
	const nextNodes: T[] = [];

	for (const node of nodes) {
		if (node.id === nodeId) {
			extracted = node;
			continue;
		}

		if (node.type === 'group' && node.children) {
			const childResult = extractNodeById(node.children as T[], nodeId);
			if (childResult.extracted) {
				extracted = childResult.extracted;
				nextNodes.push({ ...node, children: childResult.nodes } as T);
			} else {
				nextNodes.push(node);
			}
		} else {
			nextNodes.push(node);
		}
	}

	return { nodes: nextNodes, extracted };
}

export function insertNodeRelative<T extends ManipulableNode>(
	nodes: T[],
	targetId: string,
	nodeToInsert: T,
	position: DropPosition,
): { nodes: T[]; inserted: boolean } {
	const nextNodes: T[] = [];
	let inserted = false;

	for (const node of nodes) {
		if (!inserted && node.id === targetId && position === 'before') {
			nextNodes.push(nodeToInsert);
			inserted = true;
		}

		if (node.type === 'group' && !inserted && node.children) {
			const childResult = insertNodeRelative(node.children as T[], targetId, nodeToInsert, position);
			if (childResult.inserted) {
				nextNodes.push({ ...node, children: childResult.nodes } as T);
				inserted = true;
			} else {
				nextNodes.push(node);
			}
		} else {
			nextNodes.push(node);
		}

		if (!inserted && node.id === targetId && position === 'after') {
			nextNodes.push(nodeToInsert);
			inserted = true;
		}
	}

	return { nodes: nextNodes, inserted };
}

export function appendNodeToGroupEnd<T extends ManipulableNode>(
	nodes: T[],
	targetGroupId: string,
	nodeToInsert: T,
): { nodes: T[]; inserted: boolean } {
	let inserted = false;
	const nextNodes = nodes.map(node => {
		if (node.type !== 'group' || !node.children) {
			return node;
		}
		if (node.id === targetGroupId) {
			inserted = true;
			return { ...node, children: [...node.children, nodeToInsert] } as unknown as T;
		}

		const childResult = appendNodeToGroupEnd(node.children as T[], targetGroupId, nodeToInsert);
		if (childResult.inserted) {
			inserted = true;
			return { ...node, children: childResult.nodes } as unknown as T;
		}
		return node;
	});

	return { nodes: nextNodes, inserted };
}

export function moveNodeRelative<T extends ManipulableNode>(
	nodes: T[],
	draggedId: string,
	targetId: string,
	position: DropPosition,
): T[] {
	if (draggedId === targetId) {
		return nodes;
	}

	const extracted = extractNodeById(nodes, draggedId);
	if (!extracted.extracted) {
		return nodes;
	}

	const inserted = insertNodeRelative(extracted.nodes, targetId, extracted.extracted, position);
	return inserted.inserted ? inserted.nodes : nodes;
}

export function moveNodeToGroupEnd<T extends ManipulableNode>(
	nodes: T[],
	draggedId: string,
	targetGroupId: string,
): T[] {
	const extracted = extractNodeById(nodes, draggedId);
	if (!extracted.extracted) {
		return nodes;
	}

	const inserted = appendNodeToGroupEnd(extracted.nodes, targetGroupId, extracted.extracted);
	return inserted.inserted ? inserted.nodes : nodes;
}

export function normalizeGroupLevels<T extends ManipulableNode>(nodes: T[], parentLevel?: number): T[] {
	const normalizedLevel = parentLevel === undefined ? 2 : Math.min(parentLevel + 1, 6);

	return nodes.map(node => {
		if (node.type !== 'group' || !node.children) {
			return node;
		}

		return {
			...node,
			level: normalizedLevel,
			children: normalizeGroupLevels(node.children as T[], normalizedLevel),
		} as unknown as T;
	});
}
