/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CodeTourDocument, HunkReference, TourGroupNode, TourHunkNode, TourNode, TourTextNode } from '../../src/github/codeTourMarkdown';

interface CodeTourEditorProps {
	document: CodeTourDocument;
	onDocumentChange: (markdown: string) => void;
	onInsertHunk: (hunk: HunkReference) => void;
}

/* - Helpers: deep-clone & mutate the node tree ------------ */

let _nextLocalId = 1000;
function localId(): string {
	return `local-${_nextLocalId++}`;
}

function cloneDoc(doc: CodeTourDocument): CodeTourDocument {
	return JSON.parse(JSON.stringify(doc));
}

function updateNodeInList(nodes: TourNode[], id: string, updater: (n: TourNode) => TourNode): TourNode[] {
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

function removeNodeFromList(nodes: TourNode[], id: string): TourNode[] {
	const result: TourNode[] = [];
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

function appendToList(nodes: TourNode[], node: TourNode): TourNode[] {
	return [...nodes, node];
}

function appendToGroup(nodes: TourNode[], groupId: string, node: TourNode): TourNode[] {
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

/* - Serializer (local, mirrors codeTourMarkdown.ts) -------- */

function serializeDoc(doc: CodeTourDocument): string {
	const lines: string[] = [];
	lines.push(`# ${doc.title}`);
	lines.push('');

	function walk(nodes: TourNode[]): void {
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
				case 'hunk':
					lines.push(`:::hunk file=${node.hunk.file} lines=${node.hunk.startLine}-${node.hunk.endLine} ref=${node.hunk.ref}:::`);
					lines.push('');
					break;
			}
		}
	}

	walk(doc.children);
	return lines.join('\n').replace(/\n+$/, '\n');
}

/* - Drop zone component ----------------------- */

function DropZone({ onDrop }: { onDrop: (hunk: HunkReference) => void }) {
	const [over, setOver] = useState(false);

	const handleDragOver = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		e.dataTransfer.dropEffect = 'copy';
		setOver(true);
	}, []);

	const handleDragLeave = useCallback(() => {
		setOver(false);
	}, []);

	const handleDrop = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		setOver(false);
		const raw = e.dataTransfer.getData('application/vnd.codetour.hunk+json');
		if (raw) {
			try {
				const hunk: HunkReference = JSON.parse(raw);
				onDrop(hunk);
			} catch {
				// ignore malformed data
			}
		}
	}, [onDrop]);

	return (
		<div
			className={`drop-zone ${over ? 'drop-zone-active' : ''}`}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
			<span className="codicon codicon-add" />
			<span>Drop a hunk here</span>
		</div>
	);
}

/* - Hunk display component ---------------------- */

function HunkBlock({ node, onRemove }: { node: TourHunkNode; onRemove: (id: string) => void }) {
	const { file, startLine, endLine, ref } = node.hunk;
	return (
		<div className="tour-hunk">
			<div className="tour-hunk-header">
				<span className="codicon codicon-file-code" />
				<span className="tour-hunk-file">{file}</span>
				<span className="tour-hunk-lines">L{startLine}&ndash;{endLine}</span>
				<span className="tour-hunk-ref" title={ref}>{ref.substring(0, 7)}</span>
				<button className="tour-remove-btn" title="Remove hunk" onClick={() => onRemove(node.id)}>&times;</button>
			</div>
			<div className="tour-hunk-placeholder">
				Diff hunk from <strong>{file}</strong> lines {startLine}&ndash;{endLine}
			</div>
		</div>
	);
}

/* - Text block component (editable) ----------------- */

function TextBlock({
	node,
	onChange,
	onRemove,
}: {
	node: TourTextNode;
	onChange: (id: string, content: string) => void;
	onRemove: (id: string) => void;
}) {
	const ref = useRef<HTMLTextAreaElement>(null);

	// Auto-resize textarea to fit content
	const resize = useCallback(() => {
		const el = ref.current;
		if (el) {
			el.style.height = 'auto';
			el.style.height = `${el.scrollHeight}px`;
		}
	}, []);

	useEffect(() => {
		resize();
	}, [node.content, resize]);

	const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
		onChange(node.id, e.target.value);
		resize();
	}, [node.id, onChange, resize]);

	return (
		<div className="tour-text-wrapper">
			<textarea
				ref={ref}
				className="tour-text"
				value={node.content}
				onChange={handleChange}
				placeholder="Type markdown text here…"
				rows={1}
			/>
			<button
				className="tour-remove-btn tour-text-remove"
				title="Remove text block"
				onClick={() => onRemove(node.id)}
			>
				&times;
			</button>
		</div>
	);
}

/* - Group component (collapsible) ------------------ */

function GroupBlock({
	node,
	onTextChange,
	onHunkDrop,
	onAddText,
	onAddGroup,
	onRemove,
}: {
	node: TourGroupNode;
	onTextChange: (id: string, content: string) => void;
	onHunkDrop: (hunk: HunkReference, groupId?: string) => void;
	onAddText: (groupId?: string) => void;
	onAddGroup: (parentGroupId?: string) => void;
	onRemove: (id: string) => void;
}) {
	const [collapsed, setCollapsed] = useState(false);
	const HeadingTag = `h${Math.min(node.level, 6)}` as keyof JSX.IntrinsicElements;

	const handleGroupDrop = useCallback((hunk: HunkReference) => {
		onHunkDrop(hunk, node.id);
	}, [onHunkDrop, node.id]);

	return (
		<div className={`tour-group tour-group-level-${node.level}`}>
			<div className="tour-group-header">
				<span
					className={`expand-icon ${collapsed ? '' : 'expanded'}`}
					onClick={() => setCollapsed(c => !c)}
				>
					&#9656;
				</span>
				<HeadingTag className="tour-group-title">{node.title}</HeadingTag>
				<button className="tour-remove-btn" title="Remove section" onClick={() => onRemove(node.id)}>&times;</button>
			</div>
			{!collapsed && (
				<div className="tour-group-body">
					{node.children.map(child => (
						<NodeRenderer
							key={child.id}
							node={child}
							onTextChange={onTextChange}
							onHunkDrop={onHunkDrop}
							onAddText={onAddText}
							onAddGroup={onAddGroup}
							onRemove={onRemove}
						/>
					))}
					<div className="tour-group-actions">
						<button className="tour-add-btn" onClick={() => onAddText(node.id)}>+ Text</button>
						{node.level < 6 && (
							<button className="tour-add-btn" onClick={() => onAddGroup(node.id)}>+ Sub-section</button>
						)}
					</div>
					<DropZone onDrop={handleGroupDrop} />
				</div>
			)}
		</div>
	);
}

/* - Generic node renderer ---------------------- */

function NodeRenderer({
	node,
	onTextChange,
	onHunkDrop,
	onAddText,
	onAddGroup,
	onRemove,
}: {
	node: TourNode;
	onTextChange: (id: string, content: string) => void;
	onHunkDrop: (hunk: HunkReference, groupId?: string) => void;
	onAddText: (groupId?: string) => void;
	onAddGroup: (parentGroupId?: string) => void;
	onRemove: (id: string) => void;
}) {
	switch (node.type) {
		case 'group':
			return (
				<GroupBlock
					node={node}
					onTextChange={onTextChange}
					onHunkDrop={onHunkDrop}
					onAddText={onAddText}
					onAddGroup={onAddGroup}
					onRemove={onRemove}
				/>
			);
		case 'text':
			return <TextBlock node={node} onChange={onTextChange} onRemove={onRemove} />;
		case 'hunk':
			return <HunkBlock node={node} onRemove={onRemove} />;
	}
}

/* - Main editor component ---------------------- */

export function CodeTourEditor({ document: initialDoc, onDocumentChange }: CodeTourEditorProps) {
	const [doc, setDoc] = useState<CodeTourDocument>(() => cloneDoc(initialDoc));
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
	const applyLocal = useCallback((updater: (prev: CodeTourDocument) => CodeTourDocument) => {
		isLocalEdit.current = true;
		setDoc(updater);
	}, []);

	/* - Title editing ------------------------ */

	const handleTitleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		const value = e.target.value;
		applyLocal(prev => ({ ...prev, title: value }));
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
				const findLevel = (nodes: TourNode[]): number | undefined => {
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

			const group: TourGroupNode = {
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

	/* - Hunk drop (into a specific group or root) ---------- */

	const handleHunkDrop = useCallback((hunk: HunkReference, groupId?: string) => {
		applyLocal(prev => {
			const hunkNode: TourHunkNode = {
				type: 'hunk',
				id: localId(),
				hunk,
			};
			return {
				...prev,
				children: groupId
					? appendToGroup(prev.children, groupId, hunkNode)
					: appendToList(prev.children, hunkNode),
			};
		});
	}, [applyLocal]);

	const handleRootHunkDrop = useCallback((hunk: HunkReference) => {
		handleHunkDrop(hunk);
	}, [handleHunkDrop]);

	return (
		<div className="code-tour-editor">
			<input
				className="tour-title-input"
				value={doc.title}
				onChange={handleTitleChange}
				placeholder="Code Tour Title"
			/>
			<div className="tour-body">
				{doc.children.map(node => (
					<NodeRenderer
						key={node.id}
						node={node}
						onTextChange={handleTextChange}
						onHunkDrop={handleHunkDrop}
						onAddText={handleAddText}
						onAddGroup={handleAddGroup}
						onRemove={handleRemove}
					/>
				))}
				<div className="tour-root-actions">
					<button className="tour-add-btn" onClick={() => handleAddText()}>+ Text</button>
					<button className="tour-add-btn" onClick={() => handleAddGroup()}>+ Section</button>
				</div>
				<DropZone onDrop={handleRootHunkDrop} />
			</div>
		</div>
	);
}
