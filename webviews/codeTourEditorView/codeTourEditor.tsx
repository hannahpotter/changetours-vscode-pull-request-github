/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as marked from 'marked';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CodeTourDocument, HunkReference, TourTextNode } from '../../src/github/codeTourMarkdown';
import { DiffTable } from '../common/DiffTable';
import { parsePatch } from '../common/diffUtils';
import { chevronDownIcon, gripperIcon } from '../components/icon';

// Editor-only node type: a pending drop zone placeholder (never serialized).
interface TourDropZoneNode {
	type: 'dropzone';
	id: string;
}

// Editor-local hunk node extends TourHunkNode with optional patch content (now serialized in hunk.patch).
interface EditorHunkNode {
	type: 'hunk';
	id: string;
	hunk: HunkReference;
}

// Editor-local group node mirrors TourGroupNode but allows EditorNode children.
interface EditorGroupNode {
	type: 'group';
	id: string;
	title: string;
	level: number;
	children: EditorNode[];
}

type EditorNode = EditorGroupNode | TourTextNode | EditorHunkNode | TourDropZoneNode;

type DropPosition = 'before' | 'after';

interface ReorderDragState {
	nodeId: string;
}

marked.setOptions({ breaks: true });

// Editor-local document mirrors CodeTourDocument but allows EditorNode children.
interface EditorDocument {
	title: string;
	prNumber?: number;
	prOwner?: string;
	prRepo?: string;
	isPR?: boolean;
	baseRef?: string;
	children: EditorNode[];
}

interface CodeTourEditorProps {
	document: CodeTourDocument;
	activePR?: { number: number; owner: string; repo: string };
	isEditMode?: boolean;
	onDocumentChange: (markdown: string) => void;
	onInsertHunk: (hunk: HunkReference) => void;
	onOpenDiff?: (hunk: HunkReference) => void;
	onError?: (message: string) => void;
}

const HUNK_MIME_TYPE = 'application/vnd.codetour.hunk+json';

/* - Helpers: deep-clone & mutate the node tree ------------ */

let _nextLocalId = 1000;
function localId(): string {
	return `local-${_nextLocalId++}`;
}

function cloneDoc(doc: CodeTourDocument): EditorDocument {
	return JSON.parse(JSON.stringify(doc));
}

function updateNodeInList(nodes: EditorNode[], id: string, updater: (n: EditorNode) => EditorNode): EditorNode[] {
	return nodes.map(n => {
		if (n.id === id) {
			return updater(n);
		}
		if (n.type === 'group') {
			return { ...n, children: updateNodeInList(n.children, id, updater) };
		}
		return n;
	});
}

function removeNodeFromList(nodes: EditorNode[], id: string): EditorNode[] {
	const result: EditorNode[] = [];
	for (const n of nodes) {
		if (n.id === id) {
			continue;
		}
		if (n.type === 'group') {
			result.push({ ...n, children: removeNodeFromList(n.children, id) });
		} else {
			result.push(n);
		}
	}
	return result;
}

function appendToList(nodes: EditorNode[], node: EditorNode): EditorNode[] {
	return [...nodes, node];
}

function appendToGroup(nodes: EditorNode[], groupId: string, node: EditorNode): EditorNode[] {
	return nodes.map(n => {
		if (n.id === groupId && n.type === 'group') {
			return { ...n, children: [...n.children, node] };
		}
		if (n.type === 'group') {
			return { ...n, children: appendToGroup(n.children, groupId, node) };
		}
		return n;
	});
}

function extractNodeById(nodes: EditorNode[], nodeId: string): { nodes: EditorNode[]; extracted?: EditorNode } {
	let extracted: EditorNode | undefined;
	const nextNodes: EditorNode[] = [];

	for (const node of nodes) {
		if (node.id === nodeId) {
			extracted = node;
			continue;
		}

		if (node.type === 'group') {
			const childResult = extractNodeById(node.children, nodeId);
			if (childResult.extracted) {
				extracted = childResult.extracted;
				nextNodes.push({ ...node, children: childResult.nodes });
			} else {
				nextNodes.push(node);
			}
		} else {
			nextNodes.push(node);
		}
	}

	return { nodes: nextNodes, extracted };
}

function insertNodeRelative(
	nodes: EditorNode[],
	targetId: string,
	nodeToInsert: EditorNode,
	position: DropPosition,
): { nodes: EditorNode[]; inserted: boolean } {
	const nextNodes: EditorNode[] = [];
	let inserted = false;

	for (const node of nodes) {
		if (!inserted && node.id === targetId && position === 'before') {
			nextNodes.push(nodeToInsert);
			inserted = true;
		}

		if (node.type === 'group' && !inserted) {
			const childResult = insertNodeRelative(node.children, targetId, nodeToInsert, position);
			if (childResult.inserted) {
				nextNodes.push({ ...node, children: childResult.nodes });
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

function appendNodeToGroupEnd(
	nodes: EditorNode[],
	targetGroupId: string,
	nodeToInsert: EditorNode,
): { nodes: EditorNode[]; inserted: boolean } {
	let inserted = false;
	const nextNodes = nodes.map(node => {
		if (node.type !== 'group') {
			return node;
		}
		if (node.id === targetGroupId) {
			inserted = true;
			return { ...node, children: [...node.children, nodeToInsert] };
		}

		const childResult = appendNodeToGroupEnd(node.children, targetGroupId, nodeToInsert);
		if (childResult.inserted) {
			inserted = true;
			return { ...node, children: childResult.nodes };
		}
		return node;
	});

	return { nodes: nextNodes, inserted };
}

function moveNodeRelative(nodes: EditorNode[], draggedId: string, targetId: string, position: DropPosition): EditorNode[] {
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

function moveNodeToGroupEnd(nodes: EditorNode[], draggedId: string, targetGroupId: string): EditorNode[] {
	const extracted = extractNodeById(nodes, draggedId);
	if (!extracted.extracted) {
		return nodes;
	}

	const inserted = appendNodeToGroupEnd(extracted.nodes, targetGroupId, extracted.extracted);
	return inserted.inserted ? inserted.nodes : nodes;
}

function normalizeGroupLevels(nodes: EditorNode[], parentLevel?: number): EditorNode[] {
	const normalizedLevel = parentLevel === undefined ? 2 : Math.min(parentLevel + 1, 6);

	return nodes.map(node => {
		if (node.type !== 'group') {
			return node;
		}

		return {
			...node,
			level: normalizedLevel,
			children: normalizeGroupLevels(node.children, normalizedLevel),
		};
	});
}

/* - Serializer (local, mirrors codeTourMarkdown.ts) -------- */

function serializeDoc(doc: EditorDocument): string {
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

	function walk(nodes: EditorNode[]): void {
		for (const node of nodes) {
			switch (node.type) {
				case 'group': {
					const prefix = '#'.repeat(node.level);
					lines.push(`${prefix} ${node.title}`);
					lines.push('');
					walk(node.children);
					break;
				}
				case 'text':
					lines.push(node.content);
					lines.push('');
					break;
				case 'hunk': {
					let hunkHeader = `:::hunk file=${node.hunk.file} lines=${node.hunk.startLine}-${node.hunk.endLine} ref=${node.hunk.ref}`;
					if (node.hunk.previousFile) hunkHeader += ` previousFile=${node.hunk.previousFile}`;
					lines.push(hunkHeader);
					if (node.hunk.patch) {
						lines.push(node.hunk.patch);
					}
					lines.push(':::');
					lines.push('');
					break;
				}
				case 'dropzone':
					// Ephemeral UI-only node, not serialized
					break;
			}
		}
	}

	walk(doc.children);
	return lines.join('\n').replace(/\n+$/, '\n');
}

/* - Drop zone block (pending hunk placeholder) ----------- */

// Extended payload from drag that may include patch content
interface HunkPayload extends HunkReference {
	isPR?: boolean;
	baseRef?: string;
	prNumber?: number;
	prOwner?: string;
	prRepo?: string;
}

function getDropPosition(event: React.DragEvent<HTMLElement>): DropPosition {
	const rect = event.currentTarget.getBoundingClientRect();
	return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}

function NodeShell({
	node,
	dragState,
	onDragStart,
	onDragEnd,
	onReorder,
	isEditMode,
	children,
}: {
	node: EditorNode;
	dragState: ReorderDragState | null;
	onDragStart: (nodeId: string) => void;
	onDragEnd: () => void;
	onReorder: (draggedId: string, targetId: string, position: DropPosition) => void;
	isEditMode: boolean;
	children: React.ReactNode;
}) {
	const [dropPosition, setDropPosition] = useState<DropPosition | null>(null);
	const isDraggable = isEditMode;
	const canAcceptDrop = isEditMode && !!dragState && dragState.nodeId !== node.id;

	useEffect(() => {
		if (!dragState) {
			setDropPosition(null);
		}
	}, [dragState]);

	const handleDragStart = useCallback((event: React.DragEvent<HTMLButtonElement>) => {
		event.stopPropagation();
		onDragStart(node.id);
		event.dataTransfer.effectAllowed = 'move';
	}, [node.id, onDragStart]);

	const handleDragEnd = useCallback(() => {
		setDropPosition(null);
		onDragEnd();
	}, [onDragEnd]);

	const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
		if (!canAcceptDrop) {
			return;
		}
		event.preventDefault();
		event.dataTransfer.dropEffect = 'move';
		setDropPosition(getDropPosition(event));
	}, [canAcceptDrop]);

	const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
		const relatedTarget = event.relatedTarget;
		if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
			return;
		}
		setDropPosition(null);
	}, []);

	const handleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
		if (!canAcceptDrop || !dragState) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		const nextDropPosition = dropPosition ?? getDropPosition(event);
		onReorder(dragState.nodeId, node.id, nextDropPosition);
		setDropPosition(null);
		onDragEnd();
	}, [canAcceptDrop, dragState, dropPosition, node.id, onDragEnd, onReorder]);

	return (
		<div
			className={[
				'tour-node-shell',
				isDraggable ? 'tour-node-shell-draggable' : '',
				dropPosition ? `tour-node-shell-drop-${dropPosition}` : '',
			].filter(Boolean).join(' ')}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
			{isDraggable && (
				<span
					className="tour-node-drag-handle icon-button"
					title="Drag to reorder"
					draggable
					onDragStart={handleDragStart}
					onDragEnd={handleDragEnd}
				>
					{gripperIcon}
				</span>
			)}
			{children}
		</div>
	);
}

function DropZoneBlock({
	node,
	doc,
	onError,
	onDrop,
	onRemove,
}: {
	node: TourDropZoneNode;
	doc: EditorDocument;
	onError?: (message: string) => void;
	onDrop: (id: string, payload: HunkPayload) => void;
	onRemove: (id: string) => void;
}) {
	const [over, setOver] = useState(false);

	const handleDragOver = useCallback((e: React.DragEvent) => {
		if (!e.dataTransfer.types.includes(HUNK_MIME_TYPE)) {
			return;
		}
		e.preventDefault();
		e.dataTransfer.dropEffect = 'copy';
		setOver(true);
	}, []);

	const handleDragLeave = useCallback(() => {
		setOver(false);
	}, []);

	const handleDrop = useCallback((e: React.DragEvent) => {
		if (!e.dataTransfer.types.includes(HUNK_MIME_TYPE)) {
			return;
		}
		e.preventDefault();
		setOver(false);
		const raw = e.dataTransfer.getData(HUNK_MIME_TYPE);
		if (raw) {
			try {
				const payload: HunkPayload = JSON.parse(raw);

				if (doc.isPR) {
					const prNumberMatches = !doc.prNumber || !payload.prNumber || String(doc.prNumber) === String(payload.prNumber);
					const prOwnerMatches = !doc.prOwner || !payload.prOwner || doc.prOwner === payload.prOwner;
					const prRepoMatches = !doc.prRepo || !payload.prRepo || doc.prRepo === payload.prRepo;

					if (!prNumberMatches || !prOwnerMatches || !prRepoMatches) {
						const msg = `Cannot drop a hunk from a different pull request. Expected PR #${doc.prNumber} (${doc.prOwner}/${doc.prRepo}), but got PR #${payload.prNumber} (${payload.prOwner}/${payload.prRepo})`;
						if (onError) {
							onError(msg);
						} else {
							window.alert(msg);
						}
						return;
					}
				}

				onDrop(node.id, payload);
			} catch {
				// ignore malformed data
			}
		}
	}, [node.id, onDrop, doc, onError]);

	return (
		<div className="tour-text-wrapper">
			<div
				className={`drop-zone ${over ? 'drop-zone-active' : ''}`}
				onDragOver={handleDragOver}
				onDragLeave={handleDragLeave}
				onDrop={handleDrop}
			>
				<span>Drop a hunk here</span>
			</div>
			<button
				className="tour-remove-btn tour-text-remove"
				title="Remove drop zone"
				onClick={() => onRemove(node.id)}
			>
				&times;
			</button>
		</div>
	);
}

/* - Hunk display component ---------------------- */

function HunkBlock({ node, doc, onRemove, onOpenDiff, activePR, isEditMode }: { node: EditorHunkNode; doc: EditorDocument; onRemove: (id: string) => void; onOpenDiff?: (hunk: HunkReference) => void; activePR?: { number: number; owner: string; repo: string }; isEditMode: boolean }) {
	const { file, startLine, endLine, ref, patch } = node.hunk;
	const lines = useMemo(() => patch ? parsePatch(patch) : [], [patch]);

	const isMismatch = doc.isPR && (
		doc.prNumber !== activePR?.number ||
		doc.prOwner !== activePR?.owner ||
		doc.prRepo !== activePR?.repo
	);

	return (
		<div className="tour-hunk">
			<div className="tour-hunk-header">
				<span className="tour-hunk-file">{file}</span>
				<span className="tour-hunk-lines">L{startLine}&ndash;{endLine}</span>
				<span className="tour-hunk-ref" title={ref}>{ref.substring(0, 7)}</span>
				<div className="tour-hunk-actions">
					{onOpenDiff && (
						<button
							className="tour-action-btn"
							style={isMismatch ? { opacity: 0.5 } : {}}
							title={isMismatch ? 'Checkout the associated PR to view the diff' : 'Open Diff'}
							onClick={() => onOpenDiff(node.hunk)}
						>
							Open Diff
						</button>
					)}
					{isEditMode && (
						<button className="tour-remove-btn" title="Remove hunk" onClick={() => onRemove(node.id)}>&times;</button>
					)}
				</div>
			</div>
			{lines.length > 0 ? (
				<DiffTable lines={lines} />
			) : (
				<div className="tour-hunk-placeholder">
					Diff hunk from <strong>{file}</strong> lines {startLine}&ndash;{endLine}
				</div>
			)}
		</div>
	);
}

/* - Text block component (editable) ----------------- */

function TextBlock({
	node,
	onChange,
	onRemove,
	isEditMode,
}: {
	node: TourTextNode;
	onChange: (id: string, content: string) => void;
	onRemove: (id: string) => void;
	isEditMode: boolean;
}) {
	const [editing, setEditing] = useState(isEditMode && !node.content);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	// Auto-resize textarea to fit content
	const resize = useCallback(() => {
		const el = textareaRef.current;
		if (el) {
			el.style.height = 'auto';
			el.style.height = `${el.scrollHeight}px`;
		}
	}, []);

	useEffect(() => {
		if (editing) {
			resize();
			textareaRef.current?.focus();
		}
	}, [editing, resize]);

	useEffect(() => {
		resize();
	}, [node.content, resize]);

	const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
		onChange(node.id, e.target.value);
		resize();
	}, [node.id, onChange, resize]);

	const handleBlur = useCallback(() => {
		if (node.content.trim()) {
			setEditing(false);
		}
	}, [node.content]);

	const renderedHtml = useMemo(() => {
		if (editing || !node.content) {
			return '';
		}
		return marked.parse(node.content) as string;
	}, [editing, node.content]);

	if (editing && isEditMode) {
		return (
			<div className="tour-text-wrapper">
				<textarea
					ref={textareaRef}
					className="tour-text"
					value={node.content}
					onChange={handleChange}
					onBlur={handleBlur}
					placeholder="Type markdown text here…"
					rows={1}
				/>
				<button
					className="tour-remove-btn tour-text-remove"
					title="Remove text block"
					onMouseDown={e => { e.preventDefault(); onRemove(node.id); }}
				>
					&times;
				</button>
			</div>
		);
	}

	return (
		<div className="tour-text-wrapper">
			<div
				className="tour-text-rendered"
				onClick={() => isEditMode && setEditing(true)}
				dangerouslySetInnerHTML={{ __html: renderedHtml }}
			/>
			{isEditMode && (
				<button
					className="tour-remove-btn tour-text-remove"
					title="Remove text block"
					onClick={() => onRemove(node.id)}
				>
					&times;
				</button>
			)}
		</div>
	);
}

/* - Group component (collapsible) ------------------ */

function GroupBlock({
	node,
	doc,
	dragState,
	onNodeDragStart,
	onNodeDragEnd,
	onReorder,
	onMoveToGroupEnd,
	onTextChange,
	onGroupTitleChange,
	onDropZoneDrop,
	onAddText,
	onAddCode,
	onAddGroup,
	onRemove,
	onOpenDiff,
	activePR,
	isEditMode,
	onError,
}: {
	node: EditorGroupNode;
	doc: EditorDocument;
	dragState: ReorderDragState | null;
	onNodeDragStart: (nodeId: string) => void;
	onNodeDragEnd: () => void;
	onReorder: (draggedId: string, targetId: string, position: DropPosition) => void;
	onMoveToGroupEnd: (draggedId: string, groupId: string) => void;
	onTextChange: (id: string, content: string) => void;
	onGroupTitleChange: (id: string, title: string) => void;
	onDropZoneDrop: (id: string, payload: HunkPayload) => void;
	onAddText: (groupId?: string) => void;
	onAddCode: (groupId?: string) => void;
	onAddGroup: (parentGroupId?: string) => void;
	onRemove: (id: string) => void;
	onOpenDiff?: (hunk: HunkReference) => void;
	isEditMode: boolean;
	onError?: (message: string) => void;
	activePR?: { number: number; owner: string; repo: string };
}) {
	const [collapsed, setCollapsed] = useState(false);
	const [groupDropActive, setGroupDropActive] = useState(false);

	const handleTitleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		onGroupTitleChange(node.id, e.target.value);
	}, [node.id, onGroupTitleChange]);

	const handleGroupBodyDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
		if (!dragState || collapsed) {
			return;
		}
		e.preventDefault();
		e.dataTransfer.dropEffect = 'move';
		setGroupDropActive(true);
	}, [collapsed, dragState]);

	const handleGroupBodyDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
		const relatedTarget = e.relatedTarget;
		if (relatedTarget instanceof Node && e.currentTarget.contains(relatedTarget)) {
			return;
		}
		setGroupDropActive(false);
	}, []);

	const handleGroupBodyDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
		if (!dragState || collapsed) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		onMoveToGroupEnd(dragState.nodeId, node.id);
		setGroupDropActive(false);
		onNodeDragEnd();
	}, [collapsed, dragState, node.id, onMoveToGroupEnd, onNodeDragEnd]);

	useEffect(() => {
		if (!dragState) {
			setGroupDropActive(false);
		}
	}, [dragState]);

	return (
		<div className={`tour-group tour-group-level-${node.level}`}>
			<div className="tour-group-header">
				<span
					className={`expand-icon icon-button ${collapsed ? 'closed' : ''}`}
					onClick={() => setCollapsed(c => !c)}
				>
					{chevronDownIcon}
				</span>
				{isEditMode ? (
					<input
						className="tour-group-title-input"
						value={node.title}
						onChange={handleTitleChange}
						placeholder="Section title"
					/>
				) : (
					<span className="tour-group-title-readonly">{node.title || 'Untitled Section'}</span>
				)}
				{isEditMode && (
					<button className="tour-remove-btn" title="Remove section" onClick={() => onRemove(node.id)}>&times;</button>
				)}
			</div>
			{!collapsed && (
				<div
					className={`tour-group-body${groupDropActive && isEditMode ? ' tour-group-body-drop-active' : ''}`}
					onDragOver={isEditMode ? handleGroupBodyDragOver : undefined}
					onDragLeave={isEditMode ? handleGroupBodyDragLeave : undefined}
					onDrop={isEditMode ? handleGroupBodyDrop : undefined}
				>
					{node.children.map(child => (
						<NodeRenderer
							key={child.id}
							node={child}
							doc={doc}
							dragState={dragState}
							onNodeDragStart={onNodeDragStart}
							onNodeDragEnd={onNodeDragEnd}
							onReorder={onReorder}
							onMoveToGroupEnd={onMoveToGroupEnd}
							onTextChange={onTextChange}
							onGroupTitleChange={onGroupTitleChange}
							onDropZoneDrop={onDropZoneDrop}
							onAddText={onAddText}
							onAddCode={onAddCode}
							onAddGroup={onAddGroup}
							onRemove={onRemove}
							onOpenDiff={onOpenDiff}
							activePR={activePR}
							isEditMode={isEditMode}
							onError={onError}
						/>
					))}
					{isEditMode && (
						<div className="tour-group-actions">
							<button className="tour-add-btn" onClick={() => onAddText(node.id)}>+ Text</button>
							<button className="tour-add-btn" onClick={() => onAddCode(node.id)}>+ Code</button>
							{node.level < 6 && (
								<button className="tour-add-btn" onClick={() => onAddGroup(node.id)}>+ Sub-section</button>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

/* - Generic node renderer ---------------------- */

function NodeRenderer({
	node,
	doc,
	dragState,
	onNodeDragStart,
	onNodeDragEnd,
	onReorder,
	onMoveToGroupEnd,
	onTextChange,
	onGroupTitleChange,
	onDropZoneDrop,
	onAddText,
	onAddCode,
	onAddGroup,
	onRemove,
	onOpenDiff,
	activePR,
	isEditMode,
	onError,
}: {
	node: EditorNode;
	doc: EditorDocument;
	dragState: ReorderDragState | null;
	onNodeDragStart: (nodeId: string) => void;
	onNodeDragEnd: () => void;
	onReorder: (draggedId: string, targetId: string, position: DropPosition) => void;
	onMoveToGroupEnd: (draggedId: string, groupId: string) => void;
	onTextChange: (id: string, content: string) => void;
	onGroupTitleChange: (id: string, title: string) => void;
	onDropZoneDrop: (id: string, payload: HunkPayload) => void;
	onAddText: (groupId?: string) => void;
	onAddCode: (groupId?: string) => void;
	onAddGroup: (parentGroupId?: string) => void;
	onRemove: (id: string) => void;
	onOpenDiff?: (hunk: HunkReference) => void;
	isEditMode: boolean;
	onError?: (message: string) => void;
	activePR?: { number: number; owner: string; repo: string };
}) {
	switch (node.type) {
		case 'group':
			return (
				<NodeShell
					node={node}
					dragState={dragState}
					onDragStart={onNodeDragStart}
					onDragEnd={onNodeDragEnd}
					onReorder={onReorder}
					isEditMode={isEditMode}
				>
					<GroupBlock
						node={node}
						doc={doc}
						dragState={dragState}
						onNodeDragStart={onNodeDragStart}
						onNodeDragEnd={onNodeDragEnd}
						onReorder={onReorder}
						onMoveToGroupEnd={onMoveToGroupEnd}
						onTextChange={onTextChange}
						onGroupTitleChange={onGroupTitleChange}
						onDropZoneDrop={onDropZoneDrop}
						onAddText={onAddText}
						onAddCode={onAddCode}
						onAddGroup={onAddGroup}
						onRemove={onRemove}
						onOpenDiff={onOpenDiff}
						activePR={activePR}
						isEditMode={isEditMode}
						onError={onError}
					/>
				</NodeShell>
			);
		case 'text':
			return (
				<NodeShell
					node={node}
					dragState={dragState}
					onDragStart={onNodeDragStart}
					onDragEnd={onNodeDragEnd}
					onReorder={onReorder}
					isEditMode={isEditMode}
				>
					<TextBlock node={node as TourTextNode} onChange={onTextChange} onRemove={onRemove} isEditMode={isEditMode} />
				</NodeShell>
			);
		case 'hunk':
			return (
				<NodeShell
					node={node}
					dragState={dragState}
					onDragStart={onNodeDragStart}
					onDragEnd={onNodeDragEnd}
					onReorder={onReorder}
					isEditMode={isEditMode}
				>
					<HunkBlock node={node as EditorHunkNode} doc={doc} onRemove={onRemove} onOpenDiff={onOpenDiff} activePR={activePR} isEditMode={isEditMode} />
				</NodeShell>
			);
		case 'dropzone':
			if (!isEditMode) return null;
			return (
				<NodeShell
					node={node}
					dragState={dragState}
					onDragStart={onNodeDragStart}
					onDragEnd={onNodeDragEnd}
					onReorder={onReorder}
					isEditMode={isEditMode}
				>
					<DropZoneBlock node={node} doc={doc} onDrop={onDropZoneDrop} onRemove={onRemove} onError={onError} />
				</NodeShell>
			);
	}
}

/* - Main editor component ---------------------- */

export function CodeTourEditor({ document: initialDoc, onDocumentChange, onOpenDiff, activePR, isEditMode = true, onError }: CodeTourEditorProps) {
	const [doc, setDoc] = useState<EditorDocument>(() => cloneDoc(initialDoc));
	const [dragState, setDragState] = useState<ReorderDragState | null>(null);
	const isLocalEdit = useRef(false);

	// When the extension host sends an updated document (undo/redo), accept it
	// - unless we just pushed a change ourselves.
	useEffect(() => {
		if (isLocalEdit.current) {
			return;
		}
		setDoc(cloneDoc(initialDoc));
	}, [initialDoc]);

	// Whenever doc changes due to a local edit, serialize and push to the extension host.
	useEffect(() => {
		if (!isLocalEdit.current) {
			return;
		}
		isLocalEdit.current = false;
		const markdown = serializeDoc(doc);
		onDocumentChange(markdown);
	}, [doc, onDocumentChange]);

	// Helper: apply a local edit (sets the flag before updating state).
	const applyLocal = useCallback((updater: (prev: EditorDocument) => EditorDocument) => {
		isLocalEdit.current = true;
		setDoc(updater);
	}, []);

	/* - Title editing ------------------------ */

	const handleTitleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		const value = e.target.value;
		applyLocal(prev => ({ ...prev, title: value }));
	}, [applyLocal]);

	/* - Group title editing ------------------- */

	const handleGroupTitleChange = useCallback((id: string, title: string) => {
		applyLocal(prev => ({
			...prev,
			children: updateNodeInList(prev.children, id, n =>
				n.type === 'group' ? { ...n, title } : n
			),
		}));
	}, [applyLocal]);

	/* - Text editing ------------------------- */

	const handleTextChange = useCallback((id: string, content: string) => {
		applyLocal(prev => ({
			...prev,
			children: updateNodeInList(prev.children, id, n =>
				n.type === 'text' ? { ...n, content } : n
			),
		}));
	}, [applyLocal]);

	/* - Add text block ------------------------ */

	const handleAddText = useCallback((groupId?: string) => {
		applyLocal(prev => {
			const textNode: TourTextNode = { type: 'text', id: localId(), content: '' };
			return {
				...prev,
				children: groupId
					? appendToGroup(prev.children, groupId, textNode)
					: appendToList(prev.children, textNode),
			};
		});
	}, [applyLocal]);

	/* - Add section (group) --------------------- */

	const handleAddGroup = useCallback((parentGroupId?: string) => {
		applyLocal(prev => {
			let level = 2;
			if (parentGroupId) {
				const findLevel = (nodes: EditorNode[]): number | undefined => {
					for (const n of nodes) {
						if (n.id === parentGroupId && n.type === 'group') {
							return n.level + 1;
						}
						if (n.type === 'group') {
							const found = findLevel(n.children);
							if (found) {
								return found;
							}
						}
					}
					return undefined;
				};
				level = findLevel(prev.children) ?? 2;
			}

			const group: EditorGroupNode = {
				type: 'group',
				id: localId(),
				title: 'New Section',
				level: Math.min(level, 6),
				children: [],
			};

			return {
				...prev,
				children: parentGroupId
					? appendToGroup(prev.children, parentGroupId, group)
					: appendToList(prev.children, group),
			};
		});
	}, [applyLocal]);

	/* - Remove node ------------------------- */

	const handleRemove = useCallback((id: string) => {
		applyLocal(prev => ({ ...prev, children: removeNodeFromList(prev.children, id) }));
	}, [applyLocal]);

	const handleNodeDragStart = useCallback((nodeId: string) => {
		setDragState({ nodeId });
	}, []);

	const handleNodeDragEnd = useCallback(() => {
		setDragState(null);
	}, []);

	const handleReorder = useCallback((draggedId: string, targetId: string, position: DropPosition) => {
		applyLocal(prev => ({
			...prev,
			children: normalizeGroupLevels(moveNodeRelative(prev.children, draggedId, targetId, position)),
		}));
		setDragState(null);
	}, [applyLocal]);

	const handleMoveToGroupEnd = useCallback((draggedId: string, groupId: string) => {
		applyLocal(prev => ({
			...prev,
			children: normalizeGroupLevels(moveNodeToGroupEnd(prev.children, draggedId, groupId)),
		}));
		setDragState(null);
	}, [applyLocal]);

	/* - Add code drop zone -------------------- */

	const handleAddCode = useCallback((groupId?: string) => {
		applyLocal(prev => {
			const dzNode: TourDropZoneNode = { type: 'dropzone', id: localId() };
			return {
				...prev,
				children: groupId
					? appendToGroup(prev.children, groupId, dzNode)
					: appendToList(prev.children, dzNode),
			};
		});
	}, [applyLocal]);

	/* - Drop zone receives a hunk (replaces the dropzone node) --- */

	const handleDropZoneDrop = useCallback((dropZoneId: string, payload: HunkPayload) => {
		applyLocal(prev => {
			const updated = {
				...prev,
				children: updateNodeInList(prev.children, dropZoneId, () => ({
					type: 'hunk' as const,
					id: dropZoneId,
					hunk: {
						file: payload.file,
						startLine: payload.startLine,
						endLine: payload.endLine,
						ref: payload.ref,
						patch: payload.patch,
						previousFile: payload.previousFile
					},
				})),
			};

			// Bring over PR properties if the document doesn't have them yet
			if (updated.isPR === undefined && payload.isPR !== undefined) {
				updated.isPR = payload.isPR;
				updated.prNumber = payload.prNumber;
				updated.prOwner = payload.prOwner;
				updated.prRepo = payload.prRepo;
				updated.baseRef = payload.baseRef;
			}

			return updated;
		});
	}, [applyLocal]);

	return (
		<div className="code-tour-editor">
			{isEditMode ? (
				<input
					className="tour-title-input"
					value={doc.title}
					onChange={handleTitleChange}
					placeholder="Code Tour Title"
				/>
			) : (
				<h1 className="tour-title-readonly">{doc.title || 'Untitled Code Tour'}</h1>
			)}
			<div className="tour-body">
				{doc.children.map(node => (
					<NodeRenderer
						key={node.id}
						node={node}
						doc={doc}
						dragState={dragState}
						onNodeDragStart={handleNodeDragStart}
						onNodeDragEnd={handleNodeDragEnd}
						onReorder={handleReorder}
						onMoveToGroupEnd={handleMoveToGroupEnd}
						onTextChange={handleTextChange}
						onGroupTitleChange={handleGroupTitleChange}
						onDropZoneDrop={handleDropZoneDrop}
						onAddText={handleAddText}
						onAddCode={handleAddCode}
						onAddGroup={handleAddGroup}
						onRemove={handleRemove}
						onOpenDiff={onOpenDiff}
						activePR={activePR}
						isEditMode={isEditMode}
						onError={onError}
					/>
				))}
				{isEditMode && (
					<div className="tour-root-actions">
						<button className="tour-add-btn" onClick={() => handleAddText()}>+ Text</button>
						<button className="tour-add-btn" onClick={() => handleAddCode()}>+ Code</button>
						<button className="tour-add-btn" onClick={() => handleAddGroup()}>+ Section</button>
					</div>
				)}
			</div>
		</div>
	);
}
