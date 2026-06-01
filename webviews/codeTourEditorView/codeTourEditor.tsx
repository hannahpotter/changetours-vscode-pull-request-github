/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as marked from 'marked';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type CodeTourDocument, type HighlightRange, type HunkReference, serializeCodeTourMarkdown, type TourNode, type TourTextNode } from '../../src/github/codeTourMarkdown';
import { appendNodeToGroupEnd, DropPosition, insertNodeRelative, moveNodeRelative, moveNodeToGroupEnd, normalizeGroupLevels } from '../../src/github/codeTourTreeHelpers';
import { indicesFromHighlights } from '../common/diffHighlights';
import { DiffTable } from '../common/DiffTable';
import  { getHunkSummary, type ParsedDiffLine, parsePatch } from '../common/diffUtils';
import { addIcon, chevronDownIcon, codeIcon, diffSingleIcon, editIcon, eyeClosedIcon, eyeIcon, gripperIcon, newCollectionIcon, sparkleIcon, stopCircleIcon, symbolStringIcon, trashIcon } from '../components/icon';

type InsertKind = 'text' | 'code' | 'group';

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
	defaultCollapsed?: boolean;
}

type EditorNode = EditorGroupNode | TourTextNode | EditorHunkNode | TourDropZoneNode;

interface ReorderDragState {
	nodeId: string;
}

marked.setOptions({ breaks: true });

// Editor-local document mirrors CodeTourDocument but allows EditorNode children.
interface EditorDocument {
	title: string;
	schemaVersion?: number;
	prNumber?: number;
	prOwner?: string;
	prRepo?: string;
	isPR?: boolean;
	baseRef?: string;
	baseSha?: string;
	headSha?: string;
	children: EditorNode[];
}

export interface AssistantStatus {
	running: boolean;
	requestId?: string;
	label?: string;
	error?: string;
}

interface CodeTourEditorProps {
	document: CodeTourDocument;
	activePR?: { number: number; owner: string; repo: string };
	isEditMode?: boolean;
	diffLayout?: 'inline' | 'sideBySide';
	scrollToNode?: { id: string; ts: number };
	insertHunkCommand?: { ts: number, payload: HunkReference[], mode: 'active' | 'quickpick' | 'requestGroupsForQuickPick', targetId?: string };
	insertMultipleHunksCommand?: { ts: number, payloads: HunkReference[] };
	onProvideGroupsForQuickPick?: (groups: any[], hunks: HunkReference[]) => void;
	onActiveNodeChanged?: (id: string | undefined) => void;
	onDocumentChange: (markdown: string) => void;
	onCodeTourHunksChange?: (hunks: HunkReference[]) => void;
	onInsertHunk: (hunks: HunkReference[]) => void;
	onOpenDiff?: (hunk: HunkReference) => void;
	onCheckoutPR?: () => void;
	onRequestChangesOpen?: () => void;
	onError?: (message: string) => void;
	assistantStatus?: AssistantStatus;
	onRunAssistant?: (mode: 'autoGenerate' | 'narrateHunk' | 'improveSection' | 'summarizeHunk', ctx?: { hunkId?: string; groupId?: string }) => void;
	onCancelAssistant?: () => void;
	onDismissAssistantError?: () => void;
}

const HUNK_MIME_TYPE = 'application/vnd.codetour.hunk+json';

// Suppress the browser's default drag image (a snapshot of the source element
// captured at dragstart time, BEFORE React commits any setState scheduled in
// the same event handler). Without this, the floating ghost shows the OLD
// expanded hunk and obscures the page underneath - so even though we re-render
// every hunk into a compact row during the drag, the user only sees the big
// floating ghost and thinks nothing collapsed. A 1x1 transparent image makes
// the ghost effectively invisible; the actual page changes become the
// drag-time feedback. Lazy-init guarded for SSR / non-DOM contexts.
let _transparentDragImage: HTMLImageElement | undefined;
function getTransparentDragImage(): HTMLImageElement | undefined {
	if (typeof window === 'undefined' || typeof Image === 'undefined') {
		return undefined;
	}
	if (!_transparentDragImage) {
		const img = new Image();
		img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
		_transparentDragImage = img;
	}
	return _transparentDragImage;
}

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

/* - Serializer -------------------------------------------- */

/**
 * Convert the editor's local tree (which permits dropzone placeholders) into
 * the canonical CodeTourDocument tree, then delegate to the shared serializer.
 * Dropzones are ephemeral UI state and are filtered out. Keeping the editor
 * walker thin means there's exactly one on-disk format definition.
 */
function editorNodesToTourNodes(nodes: EditorNode[]): TourNode[] {
	const out: TourNode[] = [];
	for (const node of nodes) {
		if (node.type === 'dropzone') {
			continue;
		}
		if (node.type === 'group') {
			const group: TourNode = {
				type: 'group',
				id: node.id,
				title: node.title,
				level: node.level,
				children: editorNodesToTourNodes(node.children),
			};
			if (node.defaultCollapsed) {
				(group as { defaultCollapsed?: boolean }).defaultCollapsed = true;
			}
			out.push(group);
		} else {
			out.push(node);
		}
	}
	return out;
}

function serializeDoc(doc: EditorDocument): string {
	const tourDoc: CodeTourDocument = {
		title: doc.title,
		schemaVersion: doc.schemaVersion,
		prNumber: doc.prNumber,
		prOwner: doc.prOwner,
		prRepo: doc.prRepo,
		isPR: doc.isPR,
		baseRef: doc.baseRef,
		baseSha: doc.baseSha,
		headSha: doc.headSha,
		children: editorNodesToTourNodes(doc.children),
	};
	return serializeCodeTourMarkdown(tourDoc);
}

/* - Drop zone block (pending hunk placeholder) ----------- */

// Extended payload from drag that may include patch content
interface HunkPayload extends HunkReference {
	isPR?: boolean;
	baseRef?: string;
	baseSha?: string;
	headSha?: string;
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
	activeNodeId,
	onActiveNodeChanged,
	onDragStart,
	onDragEnd,
	onReorder,
	onHunkDropAtNode,
	isEditMode,
	children,
}: {
	node: EditorNode;
	dragState: ReorderDragState | null;
	activeNodeId: string | undefined;
	onActiveNodeChanged: (id: string) => void;
	onDragStart: (nodeId: string) => void;
	onDragEnd: () => void;
	onReorder: (draggedId: string, targetId: string, position: DropPosition) => void;
	onHunkDropAtNode?: (payload: HunkPayload, targetId: string, position: DropPosition) => void;
	isEditMode: boolean;
	children: React.ReactNode;
}) {
	const [dropPosition, setDropPosition] = useState<DropPosition | null>(null);
	const isDraggable = isEditMode;
	const canAcceptReorder = isEditMode && !!dragState && dragState.nodeId !== node.id;

	useEffect(() => {
		if (!dragState) {
			setDropPosition(null);
		}
	}, [dragState]);

	const handleDragStart = useCallback((event: React.DragEvent<HTMLButtonElement>) => {
		event.stopPropagation();
		const ghost = getTransparentDragImage();
		if (ghost) {
			event.dataTransfer.setDragImage(ghost, 0, 0);
		}
		onDragStart(node.id);
		event.dataTransfer.effectAllowed = 'move';
	}, [node.id, onDragStart]);

	const handleDragEnd = useCallback(() => {
		setDropPosition(null);
		onDragEnd();
	}, [onDragEnd]);

	// Accept two flavors of drag:
	//   - In-tour reorder (driven by `dragState`).
	//   - External hunk from the changes picker (carries HUNK_MIME_TYPE).
	// Both render the same blue before/after drop bar, so the user gets
	// fine-grained control of where the hunk lands instead of always being
	// appended at the end.
	const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
		if (!isEditMode) {
			return;
		}
		const isHunkDrag = !dragState && event.dataTransfer.types.includes(HUNK_MIME_TYPE);
		if (!canAcceptReorder && !(isHunkDrag && onHunkDropAtNode)) {
			return;
		}
		event.preventDefault();
		event.dataTransfer.dropEffect = canAcceptReorder ? 'move' : 'copy';
		setDropPosition(getDropPosition(event));
	}, [isEditMode, canAcceptReorder, dragState, onHunkDropAtNode]);

	const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
		const relatedTarget = event.relatedTarget;
		if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
			return;
		}
		setDropPosition(null);
	}, []);

	const handleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
		if (!isEditMode) {
			return;
		}
		const isHunkDrag = !dragState && event.dataTransfer.types.includes(HUNK_MIME_TYPE);
		if (!canAcceptReorder && !(isHunkDrag && onHunkDropAtNode)) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		const nextDropPosition = dropPosition ?? getDropPosition(event);
		if (canAcceptReorder && dragState) {
			onReorder(dragState.nodeId, node.id, nextDropPosition);
			onDragEnd();
		} else if (isHunkDrag && onHunkDropAtNode) {
			const raw = event.dataTransfer.getData(HUNK_MIME_TYPE);
			if (raw) {
				try {
					const payload: HunkPayload = JSON.parse(raw);
					onHunkDropAtNode(payload, node.id, nextDropPosition);
				} catch {
					// ignore malformed data
				}
			}
		}
		setDropPosition(null);
	}, [isEditMode, canAcceptReorder, dragState, dropPosition, node.id, onDragEnd, onReorder, onHunkDropAtNode]);

	return (
		<div
			id={`node-${node.id}`}
			className={[
				'tour-node-shell',
				isDraggable ? 'tour-node-shell-draggable' : '',
				dropPosition ? `tour-node-shell-drop-${dropPosition}` : '',
				activeNodeId === node.id ? 'tour-node-active' : ''
			].filter(Boolean).join(' ')}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
			onClick={(e) => {
				e.stopPropagation();
				if (isEditMode) {
					onActiveNodeChanged(node.id);
				}
			}}
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
		// Prevent the tour-body's fallback drop handler from also firing,
		// which would create a duplicate hunk at the end of the tour.
		e.stopPropagation();
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
				className="tour-remove-btn tour-text-remove icon-button"
				title="Remove drop zone"
				onClick={() => onRemove(node.id)}
			>
				{trashIcon}
			</button>
		</div>
	);
}

/* - Hunk display component ---------------------- */

function rangesFromDrag(lines: ParsedDiffLine[], startIdx: number, endIdx: number): HighlightRange[] {
	const lo = Math.min(startIdx, endIdx);
	const hi = Math.max(startIdx, endIdx);
	const newLines: number[] = [];
	const oldLines: number[] = [];
	for (let i = lo; i <= hi; i++) {
		const line = lines[i];
		if (!line || line.type === 'hunk-header') {
			continue;
		}
		if (line.newLine !== undefined) {
			newLines.push(line.newLine);
		}
		if (line.oldLine !== undefined) {
			oldLines.push(line.oldLine);
		}
	}
	const result: HighlightRange[] = [];
	if (newLines.length > 0) {
		result.push({ side: 'new', start: Math.min(...newLines), end: Math.max(...newLines) });
	}
	if (oldLines.length > 0) {
		result.push({ side: 'old', start: Math.min(...oldLines), end: Math.max(...oldLines) });
	}
	return result;
}

function HunkBlock({
	node,
	doc,
	onRemove,
	onOpenDiff,
	onHighlightsChange,
	onSummaryChange,
	onToggleHunkDefaultCollapsed,
	activePR,
	isEditMode,
	diffLayout,
	onRunAssistant,
	assistantRunning,
	isDragging,
}: {
	node: EditorHunkNode;
	doc: EditorDocument;
	onRemove: (id: string) => void;
	onOpenDiff?: (hunk: HunkReference) => void;
	onHighlightsChange?: (hunkId: string, highlights: HighlightRange[]) => void;
	onSummaryChange?: (hunkId: string, summary: string) => void;
	onToggleHunkDefaultCollapsed: (id: string) => void;
	activePR?: { number: number; owner: string; repo: string };
	isEditMode: boolean;
	diffLayout: 'inline' | 'sideBySide';
	onRunAssistant?: (mode: 'autoGenerate' | 'narrateHunk' | 'improveSection' | 'summarizeHunk', ctx?: { hunkId?: string; groupId?: string }) => void;
	assistantRunning?: boolean;
	isDragging?: boolean;
}) {
	const { file, startLine, endLine, patch } = node.hunk;
	const headShaShort = doc.headSha ? doc.headSha.substring(0, 7) : '';
	const lines = useMemo(() => patch ? parsePatch(patch) : [], [patch]);
	const summaryInfo = useMemo(() => getHunkSummary(node.hunk), [node.hunk]);

	const isMismatch = !!doc.isPR && (
		!activePR ||
		doc.prNumber !== activePR.number ||
		doc.prOwner?.toLowerCase() !== activePR.owner?.toLowerCase() ||
		doc.prRepo?.toLowerCase() !== activePR.repo?.toLowerCase()
	);

	// Seed and re-sync the editor's local collapse state to the hunk's
	// `defaultCollapsed` flag, so toggling the eye in the action bar also
	// flips the chevron - the creator sees exactly what the viewer would see.
	// The user can still manually expand/collapse via the chevron afterwards.
	const [collapsed, setCollapsed] = useState(() => !!node.hunk.defaultCollapsed);
	useEffect(() => {
		setCollapsed(!!node.hunk.defaultCollapsed);
	}, [node.hunk.defaultCollapsed]);
	const [highlightMode, setHighlightMode] = useState(false);
	const [dragStart, setDragStart] = useState<number | null>(null);
	const [dragEnd, setDragEnd] = useState<number | null>(null);

	const committedHighlights = node.hunk.highlights ?? [];

	const previewHighlights = useMemo(() => {
		if (dragStart === null || dragEnd === null) {
			return committedHighlights;
		}
		return [...committedHighlights, ...rangesFromDrag(lines, dragStart, dragEnd)];
	}, [committedHighlights, dragStart, dragEnd, lines]);

	const highlightedLineIndices = useMemo(
		() => indicesFromHighlights(lines, previewHighlights),
		[lines, previewHighlights],
	);

	const handleDragStart = useCallback((idx: number) => {
		setDragStart(idx);
		setDragEnd(idx);
	}, []);

	const handleDragEnter = useCallback((idx: number) => {
		setDragStart(prev => {
			if (prev === null) {
				return prev;
			}
			setDragEnd(idx);
			return prev;
		});
	}, []);

	const commitDrag = useCallback(() => {
		if (dragStart !== null && dragEnd !== null && onHighlightsChange) {
			const newRanges = rangesFromDrag(lines, dragStart, dragEnd);
			if (newRanges.length > 0) {
				onHighlightsChange(node.id, [...committedHighlights, ...newRanges]);
			}
		}
		setDragStart(null);
		setDragEnd(null);
	}, [dragStart, dragEnd, lines, committedHighlights, onHighlightsChange, node.id]);

	useEffect(() => {
		if (dragStart === null) {
			return;
		}
		const handleWindowUp = () => commitDrag();
		window.addEventListener('mouseup', handleWindowUp);
		return () => window.removeEventListener('mouseup', handleWindowUp);
	}, [dragStart, commitDrag]);

	const handleRemoveRow = useCallback((idx: number) => {
		if (!onHighlightsChange) {
			return;
		}
		const row = lines[idx];
		if (!row) {
			return;
		}
		const remaining = committedHighlights.filter(r => {
			if (r.side === 'new' && row.newLine !== undefined) {
				return !(row.newLine >= r.start && row.newLine <= r.end);
			}
			if (r.side === 'old' && row.oldLine !== undefined) {
				return !(row.oldLine >= r.start && row.oldLine <= r.end);
			}
			return true;
		});
		if (remaining.length !== committedHighlights.length) {
			onHighlightsChange(node.id, remaining);
		}
	}, [committedHighlights, lines, onHighlightsChange, node.id]);

	const highlightEditingEnabled = isEditMode && !!onHighlightsChange;

	// Auto-grow the summary textarea so long summaries wrap to multiple lines
	// instead of getting clipped or hidden behind a scrollbar. Resetting to
	// `auto` before reading scrollHeight ensures the textarea also shrinks when
	// the user deletes content.
	const summaryTextareaRef = useRef<HTMLTextAreaElement>(null);
	const resizeSummaryTextarea = useCallback(() => {
		const el = summaryTextareaRef.current;
		if (!el) {
			return;
		}
		el.style.height = 'auto';
		el.style.height = `${el.scrollHeight}px`;
	}, []);
	useEffect(() => {
		resizeSummaryTextarea();
	}, [node.hunk.summary, summaryInfo.text, isDragging, resizeSummaryTextarea]);

	// The summary editor pre-fills with the resolved auto-default (= first
	// changed line) when there's no authored summary. To let the user delete
	// every character while editing (and not snap back to the auto-default
	// the moment the textarea is empty), we hold the in-progress value in a
	// local draft state while the textarea is focused. `null` means "not
	// editing - show the resolved value"; a string (possibly empty) means
	// "editing this exact value". On blur, the draft clears and the textarea
	// re-displays whatever resolved value the parent state holds (authored
	// summary if non-empty, otherwise the auto-default).
	const [summaryDraft, setSummaryDraft] = useState<string | null>(null);
	const fallbackSummary = summaryInfo.isAuto ? summaryInfo.text : '';
	const summaryEditorValue = summaryDraft !== null
		? summaryDraft
		: (node.hunk.summary ?? fallbackSummary);
	const summaryIsAutoDraft = summaryDraft === null && !node.hunk.summary && summaryInfo.isAuto;

	const handleSummaryFocus = useCallback(() => {
		// Seed the draft with the currently displayed text so the user can
		// edit the auto-default in place, including deleting it entirely.
		setSummaryDraft(node.hunk.summary ?? fallbackSummary);
	}, [node.hunk.summary, fallbackSummary]);

	const handleSummaryInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
		const value = e.target.value;
		setSummaryDraft(value);
		// Persist each keystroke so a quick close doesn't drop the work.
		// An empty string clears the authored summary on the parent state;
		// the local draft stays empty here so the field doesn't snap back.
		if (onSummaryChange) {
			onSummaryChange(node.id, value);
		}
	}, [node.id, onSummaryChange]);

	const handleSummaryBlur = useCallback(() => {
		// Exit edit mode. The textarea will re-render to show the resolved
		// value (authored summary, or auto-default if the user left it empty).
		setSummaryDraft(null);
	}, []);

	// The `@@ -A,B +C,D @@ <scope>` line from the patch. Lives on its own row
	// inside the header so users always see git's native location/scope
	// context (regardless of whether the diff body is currently expanded).
	// DiffTable would render the same row inside the body; we suppress that
	// via CSS so the line isn't shown twice.
	const diffHunkHeaderText = useMemo(() => {
		const h = lines.find(l => l.type === 'hunk-header');
		return h?.content ?? `@@ L${startLine}-${endLine} @@`;
	}, [lines, startLine, endLine]);

	// While any drag (in-tour reorder or external hunk drop) is active, we
	// hide the diff body but keep the full 3-row header visible. That way the
	// tour reads as a stack of summary-only cards and the drop target is easy
	// to find regardless of how long each hunk's diff is. The body restores
	// automatically when the drag ends and `isDragging` flips back to false.
	const bodyHidden = collapsed || !!isDragging;

	return (
		<div className={`tour-hunk${highlightEditingEnabled && highlightMode ? ' tour-hunk-highlight-mode' : ''}`}>
			<div className="tour-hunk-header">
				{/* Row 1: chevron, file/lines/ref, actions. */}
				<div className="tour-hunk-header-row tour-hunk-header-row-meta">
					<span
						className={`expand-icon icon-button ${bodyHidden ? 'closed' : ''}`}
						onClick={() => setCollapsed(c => !c)}
					>
						{chevronDownIcon}
					</span>
					<div className="tour-hunk-info">
						<span className="tour-hunk-file" title={file}>{file}</span>
						<span className="tour-hunk-lines">L{startLine}&ndash;{endLine}</span>
						{headShaShort && (
							<span className="tour-hunk-ref" title={doc.headSha}>{headShaShort}</span>
						)}
					</div>
					<div className="tour-hunk-actions">
						{isEditMode && onRunAssistant && (
							<button
								type="button"
								className="tour-action-btn icon-button tour-assistant-button"
								title="Draft narration for this hunk with AI"
								disabled={!!assistantRunning}
								onClick={() => onRunAssistant('narrateHunk', { hunkId: node.id })}
							>
								{sparkleIcon}
							</button>
						)}
						{highlightEditingEnabled && (
							<button
								type="button"
								className={`tour-action-btn icon-button tour-hunk-highlight-toggle${highlightMode ? ' active' : ''}`}
								title={highlightMode ? 'Exit highlight mode' : 'Highlight lines (drag in the diff)'}
								aria-pressed={highlightMode}
								onClick={() => setHighlightMode(m => !m)}
							>
								{editIcon}
							</button>
						)}
						{isEditMode && (
							<button
								type="button"
								className={`tour-action-btn icon-button tour-default-collapsed-toggle${node.hunk.defaultCollapsed ? ' active' : ''}`}
								title={node.hunk.defaultCollapsed
									? "Viewer won't see this hunk by default - click to make viewer see it by default"
									: 'Viewer sees this hunk by default - click to make viewer not see it by default'}
								aria-pressed={!!node.hunk.defaultCollapsed}
								onClick={() => onToggleHunkDefaultCollapsed(node.id)}
							>
								{node.hunk.defaultCollapsed ? eyeClosedIcon : eyeIcon}
							</button>
						)}
						{onOpenDiff && (
							<button
								className="tour-action-btn icon-button"
								disabled={isMismatch}
								title={isMismatch ? 'Checkout the associated PR to open in file context' : 'Open in file context'}
								onClick={() => onOpenDiff(node.hunk)}
							>
								{diffSingleIcon}
							</button>
						)}
						{isEditMode && (
							<button className="tour-remove-btn tour-action-btn icon-button" title="Remove hunk" onClick={() => onRemove(node.id)}>
								{trashIcon}
							</button>
						)}
					</div>
				</div>
				{/* Row 2: summary editor (edit mode) or read-only summary span (view mode). */}
				<div className="tour-hunk-header-row tour-hunk-header-row-summary">
					{isEditMode && onSummaryChange ? (
						<div className="tour-hunk-summary-field">
							<textarea
								ref={summaryTextareaRef}
								className={`tour-hunk-summary-input${summaryIsAutoDraft ? ' tour-hunk-summary-auto-draft' : ''}`}
								rows={1}
								value={summaryEditorValue}
								placeholder="Describe this hunk in one sentence"
								onFocus={handleSummaryFocus}
								onChange={handleSummaryInputChange}
								onBlur={handleSummaryBlur}
								onInput={resizeSummaryTextarea}
								title="One-line description of this hunk. Pre-filled with the first changed line by default - edit to customize. Leave empty on blur to fall back to the default."
							/>
							{onRunAssistant && (
								<button
									type="button"
									className="tour-action-btn icon-button tour-assistant-button tour-hunk-summary-sparkle"
									title="Draft a one-line summary for this hunk with AI"
									disabled={!!assistantRunning}
									onClick={() => onRunAssistant('summarizeHunk', { hunkId: node.id })}
								>
									{sparkleIcon}
								</button>
							)}
						</div>
					) : (
						<span
							className={`tour-hunk-summary-text${summaryInfo.isAuto ? ' tour-hunk-summary-auto' : ''}`}
							title={summaryInfo.text}
						>
							{summaryInfo.text}
						</span>
					)}
				</div>
				{/* Row 3: native `@@` patch header line (always visible). */}
				<div className="tour-hunk-header-row tour-hunk-header-row-diff" title={diffHunkHeaderText}>
					{diffHunkHeaderText}
				</div>
			</div>
			{!bodyHidden && (
				lines.length > 0 ? (
					<DiffTable
						layout={diffLayout}
						lines={lines}
						highlightedLineIndices={highlightedLineIndices}
						highlightMode={highlightEditingEnabled && highlightMode}
						onHighlightDragStart={handleDragStart}
						onHighlightDragEnter={handleDragEnter}
						onHighlightDragEnd={commitDrag}
						onRemoveHighlightForRow={highlightEditingEnabled ? handleRemoveRow : undefined}
					/>
				) : (
					<div className="tour-hunk-placeholder">
						Diff hunk from <strong>{file}</strong> lines {startLine}&ndash;{endLine}
					</div>
				)
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
					className="tour-remove-btn tour-action-btn icon-button"
					title="Remove text block"
					onMouseDown={e => { e.preventDefault(); onRemove(node.id); }}
				>
					{trashIcon}
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
					className="tour-remove-btn tour-action-btn icon-button"
					title="Remove text block"
					onClick={() => onRemove(node.id)}
				>
					{trashIcon}
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
	isExternalHunkDragActive,
	activeNodeId,
	onActiveNodeChanged,
	onNodeDragStart,
	onNodeDragEnd,
	onReorder,
	onMoveToGroupEnd,
	onTextChange,
	onGroupTitleCommit,
	onToggleDefaultCollapsed,
	onToggleHunkDefaultCollapsed,
	onDropZoneDrop,
	onHunkDropAtNode,
	onAddText,
	onAddCode,
	onAddGroup,
	onInsertRelative,
	onHighlightsChange,
	onSummaryChange,
	onRemove,
	onOpenDiff,
	activePR,
	isEditMode,
	diffLayout,
	onError,
	onRunAssistant,
	assistantRunning,
}: {
	node: EditorGroupNode;
	doc: EditorDocument;
	dragState: ReorderDragState | null;
	isExternalHunkDragActive?: boolean;
	activeNodeId: string | undefined;
	onActiveNodeChanged: (id: string) => void;
	onNodeDragStart: (nodeId: string) => void;
	onNodeDragEnd: () => void;
	onReorder: (draggedId: string, targetId: string, position: DropPosition) => void;
	onMoveToGroupEnd: (draggedId: string, groupId: string) => void;
	onTextChange: (id: string, content: string) => void;
	onGroupTitleCommit: (id: string, title: string) => void;
	onToggleDefaultCollapsed: (id: string) => void;
	onToggleHunkDefaultCollapsed: (id: string) => void;
	onDropZoneDrop: (id: string, payload: HunkPayload) => void;
	onHunkDropAtNode?: (payload: HunkPayload, targetId: string, position: DropPosition) => void;
	onAddText: (groupId?: string) => void;
	onAddCode: (groupId?: string) => void;
	onAddGroup: (parentGroupId?: string) => void;
	onInsertRelative: (kind: InsertKind, targetId: string, position: DropPosition) => void;
	onHighlightsChange: (hunkId: string, highlights: HighlightRange[]) => void;
	onSummaryChange: (hunkId: string, summary: string) => void;
	onRemove: (id: string) => void;
	onOpenDiff?: (hunk: HunkReference) => void;
	isEditMode: boolean;
	diffLayout: 'inline' | 'sideBySide';
	onError?: (message: string) => void;
	activePR?: { number: number; owner: string; repo: string };
	onRunAssistant?: (mode: 'autoGenerate' | 'narrateHunk' | 'improveSection' | 'summarizeHunk', ctx?: { hunkId?: string; groupId?: string }) => void;
	assistantRunning?: boolean;
}) {
	// Seed and re-sync the editor's local collapse state to the section's
	// `defaultCollapsed` flag, so toggling the eye in the section header also
	// flips the chevron - the creator sees exactly what the viewer would see.
	// The user can still manually expand/collapse via the chevron afterwards.
	const [collapsed, setCollapsed] = useState(() => !!node.defaultCollapsed);
	useEffect(() => {
		setCollapsed(!!node.defaultCollapsed);
	}, [node.defaultCollapsed]);
	const [groupDropActive, setGroupDropActive] = useState(false);
	const [titleDraft, setTitleDraft] = useState(node.title);

	useEffect(() => {
		setTitleDraft(node.title);
	}, [node.id, node.title]);

	const commitTitle = useCallback(() => {
		if (titleDraft !== node.title) {
			onGroupTitleCommit(node.id, titleDraft);
		}
	}, [node.id, node.title, onGroupTitleCommit, titleDraft]);

	const handleTitleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			commitTitle();
			e.currentTarget.blur();
			return;
		}

		if (e.key === 'Escape') {
			e.preventDefault();
			setTitleDraft(node.title);
			e.currentTarget.blur();
		}
	}, [commitTitle, node.title]);

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
						value={titleDraft}
						onChange={e => setTitleDraft(e.target.value)}
						onBlur={commitTitle}
						onKeyDown={handleTitleKeyDown}
						onFocus={e => {
							// Newly-added sections start as "New Section". Treat that
							// literal as a placeholder and select it on focus so the
							// next keystroke replaces it instead of appending.
							if (e.target.value === 'New Section') {
								e.target.select();
							}
						}}
						placeholder="Section title"
					/>
				) : (
					<span className="tour-group-title-readonly">{node.title || 'Untitled Section'}</span>
				)}
				{isEditMode && (
					<button
						type="button"
						className={`tour-action-btn icon-button tour-default-collapsed-toggle${node.defaultCollapsed ? ' active' : ''}`}
						title={node.defaultCollapsed
							? "Viewer won't see this section by default - click to make viewer see it by default"
							: 'Viewer sees this section by default - click to make viewer not see it by default'}
						aria-pressed={!!node.defaultCollapsed}
						onClick={() => onToggleDefaultCollapsed(node.id)}
					>
						{node.defaultCollapsed ? eyeClosedIcon : eyeIcon}
					</button>
				)}
				{isEditMode && onRunAssistant && (
					<button
						type="button"
						className="tour-action-btn icon-button tour-assistant-button"
						title="Improve this section's narration with AI"
						disabled={!!assistantRunning}
						onClick={() => onRunAssistant('improveSection', { groupId: node.id })}
					>
						{sparkleIcon}
					</button>
				)}
				{isEditMode && (
					<button className="tour-remove-btn icon-button" title="Remove section" onClick={() => onRemove(node.id)}>
						{trashIcon}
					</button>
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
						<React.Fragment key={child.id}>
							{isEditMode && (
								<InsertGap
									parentLevel={node.level}
									onInsert={kind => onInsertRelative(kind, child.id, 'before')}
								/>
							)}
							<NodeRenderer
								node={child}
								doc={doc}
								dragState={dragState} isExternalHunkDragActive={isExternalHunkDragActive}
								activeNodeId={activeNodeId}
								onActiveNodeChanged={onActiveNodeChanged}
								onNodeDragStart={onNodeDragStart}
								onNodeDragEnd={onNodeDragEnd}
								onReorder={onReorder}
								onMoveToGroupEnd={onMoveToGroupEnd}
								onTextChange={onTextChange}
								onGroupTitleCommit={onGroupTitleCommit}
								onToggleDefaultCollapsed={onToggleDefaultCollapsed}
								onToggleHunkDefaultCollapsed={onToggleHunkDefaultCollapsed}
								onDropZoneDrop={onDropZoneDrop}
								onHunkDropAtNode={onHunkDropAtNode}
								onAddText={onAddText}
								onAddCode={onAddCode}
								onAddGroup={onAddGroup}
								onInsertRelative={onInsertRelative}
								onHighlightsChange={onHighlightsChange}
								onSummaryChange={onSummaryChange}
								onRemove={onRemove}
								onOpenDiff={onOpenDiff}
								activePR={activePR}
								isEditMode={isEditMode}
								diffLayout={diffLayout}
								onError={onError}
								onRunAssistant={onRunAssistant}
								assistantRunning={assistantRunning}
							/>
						</React.Fragment>
					))}
					{isEditMode && (
						<div className="tour-group-actions">
							<button className="tour-add-btn icon-button" title="Add text" onClick={() => onAddText(node.id)}>{symbolStringIcon}</button>
							<button className="tour-add-btn icon-button" title="Add diff" onClick={() => onAddCode(node.id)}>{codeIcon}</button>
							{node.level < 6 && (
								<button className="tour-add-btn icon-button" title="Add section" onClick={() => onAddGroup(node.id)}>{newCollectionIcon}</button>
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
	isExternalHunkDragActive,
	activeNodeId,
	onActiveNodeChanged,
	onNodeDragStart,
	onNodeDragEnd,
	onReorder,
	onMoveToGroupEnd,
	onTextChange,
	onGroupTitleCommit,
	onToggleDefaultCollapsed,
	onToggleHunkDefaultCollapsed,
	onDropZoneDrop,
	onHunkDropAtNode,
	onAddText,
	onAddCode,
	onAddGroup,
	onInsertRelative,
	onHighlightsChange,
	onSummaryChange,
	onRemove,
	onOpenDiff,
	activePR,
	isEditMode,
	diffLayout,
	onError,
	onRunAssistant,
	assistantRunning,
}: {
	node: EditorNode;
	doc: EditorDocument;
	dragState: ReorderDragState | null;
	isExternalHunkDragActive?: boolean;
	activeNodeId: string | undefined;
	onActiveNodeChanged: (id: string) => void;
	onNodeDragStart: (nodeId: string) => void;
	onNodeDragEnd: () => void;
	onReorder: (draggedId: string, targetId: string, position: DropPosition) => void;
	onMoveToGroupEnd: (draggedId: string, groupId: string) => void;
	onTextChange: (id: string, content: string) => void;
	onGroupTitleCommit: (id: string, title: string) => void;
	onToggleDefaultCollapsed: (id: string) => void;
	onToggleHunkDefaultCollapsed: (id: string) => void;
	onDropZoneDrop: (id: string, payload: HunkPayload) => void;
	onHunkDropAtNode?: (payload: HunkPayload, targetId: string, position: DropPosition) => void;
	onAddText: (groupId?: string) => void;
	onAddCode: (groupId?: string) => void;
	onAddGroup: (parentGroupId?: string) => void;
	onInsertRelative: (kind: InsertKind, targetId: string, position: DropPosition) => void;
	onHighlightsChange: (hunkId: string, highlights: HighlightRange[]) => void;
	onSummaryChange: (hunkId: string, summary: string) => void;
	onRemove: (id: string) => void;
	onOpenDiff?: (hunk: HunkReference) => void;
	isEditMode: boolean;
	diffLayout: 'inline' | 'sideBySide';
	onError?: (message: string) => void;
	activePR?: { number: number; owner: string; repo: string };
	onRunAssistant?: (mode: 'autoGenerate' | 'narrateHunk' | 'improveSection' | 'summarizeHunk', ctx?: { hunkId?: string; groupId?: string }) => void;
	assistantRunning?: boolean;
}) {
	switch (node.type) {
		case 'group':
			return (
				<NodeShell
					node={node}
					dragState={dragState}
					activeNodeId={activeNodeId}
					onActiveNodeChanged={onActiveNodeChanged}
					onDragStart={onNodeDragStart}
					onDragEnd={onNodeDragEnd}
					onReorder={onReorder}
					onHunkDropAtNode={onHunkDropAtNode}
					isEditMode={isEditMode}
				>
					<GroupBlock
						node={node}
						doc={doc}
						dragState={dragState} isExternalHunkDragActive={isExternalHunkDragActive}
						activeNodeId={activeNodeId}
						onActiveNodeChanged={onActiveNodeChanged}
						onNodeDragStart={onNodeDragStart}
						onNodeDragEnd={onNodeDragEnd}
						onReorder={onReorder}
						onMoveToGroupEnd={onMoveToGroupEnd}
						onTextChange={onTextChange}
						onGroupTitleCommit={onGroupTitleCommit}
						onToggleDefaultCollapsed={onToggleDefaultCollapsed}
						onToggleHunkDefaultCollapsed={onToggleHunkDefaultCollapsed}
						onDropZoneDrop={onDropZoneDrop}
						onHunkDropAtNode={onHunkDropAtNode}
						onAddText={onAddText}
						onAddCode={onAddCode}
						onAddGroup={onAddGroup}
						onInsertRelative={onInsertRelative}
						onHighlightsChange={onHighlightsChange}
						onSummaryChange={onSummaryChange}
						onRemove={onRemove}
						onOpenDiff={onOpenDiff}
						activePR={activePR}
						isEditMode={isEditMode}
						diffLayout={diffLayout}
						onError={onError}
						onRunAssistant={onRunAssistant}
						assistantRunning={assistantRunning}
					/>
				</NodeShell>
			);
		case 'text':
			return (
				<NodeShell
					node={node}
					dragState={dragState}
					activeNodeId={activeNodeId}
					onActiveNodeChanged={onActiveNodeChanged}
					onDragStart={onNodeDragStart}
					onDragEnd={onNodeDragEnd}
					onReorder={onReorder}
					onHunkDropAtNode={onHunkDropAtNode}
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
					activeNodeId={activeNodeId}
					onActiveNodeChanged={onActiveNodeChanged}
					onDragStart={onNodeDragStart}
					onDragEnd={onNodeDragEnd}
					onReorder={onReorder}
					onHunkDropAtNode={onHunkDropAtNode}
					isEditMode={isEditMode}
				>
					<HunkBlock node={node as EditorHunkNode} doc={doc} onRemove={onRemove} onOpenDiff={onOpenDiff} onHighlightsChange={onHighlightsChange} onSummaryChange={onSummaryChange} onToggleHunkDefaultCollapsed={onToggleHunkDefaultCollapsed} activePR={activePR} isEditMode={isEditMode} diffLayout={diffLayout} onRunAssistant={onRunAssistant} assistantRunning={assistantRunning} isDragging={!!dragState || !!isExternalHunkDragActive} />
				</NodeShell>
			);
		case 'dropzone':
			if (!isEditMode) return null;
			return (
				<NodeShell
					node={node}
					dragState={dragState}
					activeNodeId={activeNodeId}
					onActiveNodeChanged={onActiveNodeChanged}
					onDragStart={onNodeDragStart}
					onDragEnd={onNodeDragEnd}
					onReorder={onReorder}
					onHunkDropAtNode={onHunkDropAtNode}
					isEditMode={isEditMode}
				>
					<DropZoneBlock node={node} doc={doc} onDrop={onDropZoneDrop} onRemove={onRemove} onError={onError} />
				</NodeShell>
			);
	}
}

/* - Inline insert gap (insert an element between two existing nodes) -- */

function InsertGap({
	parentLevel,
	onInsert,
}: {
	parentLevel: number;
	onInsert: (kind: InsertKind) => void;
}) {
	const [open, setOpen] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) {
			return;
		}
		const handleMouseDown = (event: MouseEvent) => {
			if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
				setOpen(false);
			}
		};
		const handleKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				setOpen(false);
			}
		};
		document.addEventListener('mousedown', handleMouseDown);
		document.addEventListener('keydown', handleKey);
		return () => {
			document.removeEventListener('mousedown', handleMouseDown);
			document.removeEventListener('keydown', handleKey);
		};
	}, [open]);

	const select = useCallback((kind: InsertKind) => {
		setOpen(false);
		onInsert(kind);
	}, [onInsert]);

	return (
		<div
			ref={containerRef}
			className={`tour-insert-gap${open ? ' tour-insert-gap-open' : ''}`}
			onClick={e => e.stopPropagation()}
		>
			<button
				type="button"
				className="tour-insert-gap-btn"
				title="Insert element here"
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={e => {
					e.stopPropagation();
					setOpen(v => !v);
				}}
			>
				{addIcon}
			</button>
			{open && (
				<div className="tour-insert-gap-menu" role="menu">
					<button
						type="button"
						title="Add text"
						className="tour-add-btn icon-button"
						role="menuitem"
						onClick={() => select('text')}
					>
						{symbolStringIcon}
					</button>
					<button
						type="button"
						title="Add diff"
						className="tour-add-btn icon-button"
						role="menuitem"
						onClick={() => select('code')}
					>
						{codeIcon}
					</button>
					{parentLevel < 6 && (
						<button
							type="button"
							title="Add section"
							className="tour-add-btn icon-button"
							role="menuitem"
							onClick={() => select('group')}
						>
							{newCollectionIcon}
						</button>
					)}
				</div>
			)}
		</div>
	);
}

/* - Main editor component ---------------------- */

export function CodeTourEditor({ document: initialDoc, onDocumentChange, onCodeTourHunksChange, onOpenDiff, onCheckoutPR, onRequestChangesOpen, activePR, isEditMode = true, diffLayout = 'inline', scrollToNode, insertHunkCommand, insertMultipleHunksCommand, onProvideGroupsForQuickPick, onActiveNodeChanged, onError, assistantStatus, onRunAssistant, onCancelAssistant, onDismissAssistantError }: CodeTourEditorProps) {
	const [doc, setDoc] = useState<EditorDocument>(() => cloneDoc(initialDoc));
	const [titleDraft, setTitleDraft] = useState(initialDoc.title);
	const [dragState, setDragState] = useState<ReorderDragState | null>(null);
	// External hunk drags (originating from the Changes pane, carrying
	// HUNK_MIME_TYPE) don't go through setDragState because they aren't
	// in-tour reorders. We still want every hunk in the editor to render
	// summary-only while one is in progress so the drop target is easy to
	// find, so we track them separately via document-level listeners below.
	const [externalHunkDragActive, setExternalHunkDragActive] = useState(false);
	useEffect(() => {
		// dragstart bubble-phase: the element's own React onDragStart handler
		// runs first (changesOverview calls setData with HUNK_MIME_TYPE there),
		// so by the time this listener fires the MIME types are populated and
		// we can correctly identify it as an external hunk drag. A capture-
		// phase listener would fire BEFORE setData and see empty types.
		const onDocDragStart = (e: DragEvent) => {
			if (e.dataTransfer && Array.from(e.dataTransfer.types).includes(HUNK_MIME_TYPE)) {
				setExternalHunkDragActive(true);
			}
		};
		// dragend / drop in capture phase so we always clear even if a child
		// handler stops propagation (e.g. NodeShell's drop handler does).
		const onDocDragEnd = () => setExternalHunkDragActive(false);
		document.addEventListener('dragstart', onDocDragStart, false);
		document.addEventListener('dragend', onDocDragEnd, true);
		document.addEventListener('drop', onDocDragEnd, true);
		return () => {
			document.removeEventListener('dragstart', onDocDragStart, false);
			document.removeEventListener('dragend', onDocDragEnd, true);
			document.removeEventListener('drop', onDocDragEnd, true);
		};
	}, []);
	const editorRootRef = useRef<HTMLDivElement>(null);
	const [activeNodeId, setActiveNodeId] = useState<string | undefined>(undefined);
	const [justInsertedId, setJustInsertedId] = useState<string | undefined>(undefined);
	const isLocalEdit = useRef(false);
	const pendingDocumentSyncTimerRef = useRef<number | undefined>(undefined);
	const lastSyncedMarkdownRef = useRef<string | undefined>(undefined);
	// One-shot flag: when set, the next sync pass skips the typing-debounce
	// and pushes onDocumentChange synchronously. Used for discrete edits like
	// committing a paragraph highlight where we want Ctrl+S to never race.
	const flushImmediateRef = useRef(false);
	// Counter of self-pushed markdowns that we expect to come back through the
	// initialDoc prop (app.tsx re-parses on every onDocumentChange so the doc
	// state survives mode toggles). The initialDoc effect decrements and skips
	// override when this is > 0, keeping local node IDs stable.
	const selfEchoCountRef = useRef(0);

	useEffect(() => {
		if (justInsertedId) {
			setTimeout(() => {
				const el = document.getElementById(`node-${justInsertedId}`);
				if (el) {
					el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
					el.classList.add('tour-node-flash');
					setTimeout(() => {
						el.classList.remove('tour-node-flash');
						setJustInsertedId(undefined);
					}, 1500);
				}
			}, 100);
		}
	}, [justInsertedId]);

	useEffect(() => {
		if (onActiveNodeChanged) {
			onActiveNodeChanged(activeNodeId);
		}
	}, [activeNodeId, onActiveNodeChanged]);

	// Auto-scroll the nearest scrollable ancestor while a reorder drag is in
	// progress. Without this, dragging an item past the visible area is
	// impossible: the cursor leaves every drop target, dropPosition clears,
	// and a release outside any target cancels the operation - exactly the
	// "drag state lost" symptom users see when reordering past the fold.
	useEffect(() => {
		if (!dragState) {
			return;
		}
		const findScrollContainer = (start: HTMLElement | null): HTMLElement | null => {
			let current: HTMLElement | null = start;
			while (current && current !== document.body) {
				const style = window.getComputedStyle(current);
				const overflowY = style.overflowY;
				if (
					(overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
					current.scrollHeight > current.clientHeight
				) {
					return current;
				}
				current = current.parentElement;
			}
			return null;
		};
		const container = findScrollContainer(editorRootRef.current);
		const SCROLL_ZONE = 60;
		const MAX_SPEED = 18;
		let velocity = 0;
		let rafId: number | null = null;

		const tick = () => {
			if (velocity !== 0) {
				if (container) {
					container.scrollTop += velocity;
				} else {
					window.scrollBy(0, velocity);
				}
			}
			rafId = window.requestAnimationFrame(tick);
		};

		const handleDragOver = (e: DragEvent) => {
			const rect = container
				? container.getBoundingClientRect()
				: { top: 0, bottom: window.innerHeight } as DOMRect;
			const top = rect.top;
			const bottom = rect.bottom;
			const y = e.clientY;
			if (y < top + SCROLL_ZONE) {
				const dist = (top + SCROLL_ZONE) - y;
				velocity = -Math.min(MAX_SPEED, (dist / SCROLL_ZONE) * MAX_SPEED);
			} else if (y > bottom - SCROLL_ZONE) {
				const dist = y - (bottom - SCROLL_ZONE);
				velocity = Math.min(MAX_SPEED, (dist / SCROLL_ZONE) * MAX_SPEED);
			} else {
				velocity = 0;
			}
		};

		document.addEventListener('dragover', handleDragOver);
		rafId = window.requestAnimationFrame(tick);

		return () => {
			document.removeEventListener('dragover', handleDragOver);
			if (rafId !== null) {
				window.cancelAnimationFrame(rafId);
			}
		};
	}, [dragState]);

	useEffect(() => {
		if (scrollToNode && scrollToNode.id) {
			// use setTimeout to ensure React layout is finished just in case
			setTimeout(() => {
				const element = document.getElementById(`node-${scrollToNode.id}`);
				if (element) {
					element.scrollIntoView({ behavior: 'smooth', block: 'start' });

					// Optional: Highlight the element briefly
					element.classList.add('highlight-flash');
					setTimeout(() => element.classList.remove('highlight-flash'), 2000);
				} else {
					console.error(`CodeTour: Could not find node-${scrollToNode.id}`);
				}
			}, 0);
		}
	}, [scrollToNode]);

	// Handle insert hunk command
	useEffect(() => {
		if (!insertHunkCommand) {
			return;
		}

		if (insertHunkCommand.mode === 'active' || insertHunkCommand.mode === 'requestGroupsForQuickPick') {
			applyLocal(prev => {
					const payloads = insertHunkCommand.payload;
				let newChildren = prev.children;
				let lastInsertedId: string | undefined;
				let currentActiveId = activeNodeId;

				for (const payload of payloads) {
					const dropZoneId = localId();
					const dzNode: EditorHunkNode = {
						type: 'hunk',
						id: dropZoneId,
						hunk: {
							file: payload.file,
							startLine: payload.startLine,
							endLine: payload.endLine,
							patch: payload.patch,
							previousFile: payload.previousFile,
							baseBlob: payload.baseBlob,
						},
					};

					if (currentActiveId) {
						const inserted = insertNodeRelative(newChildren, currentActiveId, dzNode, 'after');
						if (inserted.inserted) {
							newChildren = inserted.nodes;
							currentActiveId = dropZoneId;
							lastInsertedId = dropZoneId;
						} else {
							newChildren = appendToList(newChildren, dzNode);
							lastInsertedId = dropZoneId;
						}
					} else {
						newChildren = appendToList(newChildren, dzNode);
						lastInsertedId = dropZoneId;
					}
				}

				if (lastInsertedId) setJustInsertedId(lastInsertedId);
				return { ...prev, children: newChildren };
			});
		} else if (insertHunkCommand.mode === 'quickpick') {
			if (insertHunkCommand.targetId) {
				applyLocal(prev => {
						const payloads = insertHunkCommand.payload;
					let newChildren = prev.children;
					let lastInsertedId: string | undefined;

					for (const payload of payloads) {
						const dropZoneId = localId();
						const dzNode: EditorHunkNode = {
							type: 'hunk',
							id: dropZoneId,
							hunk: {
								file: payload.file,
								startLine: payload.startLine,
								endLine: payload.endLine,
								patch: payload.patch,
								previousFile: payload.previousFile,
								baseBlob: payload.baseBlob,
							},
						};

						const inserted = appendNodeToGroupEnd(newChildren, insertHunkCommand.targetId!, dzNode);
						if (inserted.inserted) {
							newChildren = inserted.nodes;
							lastInsertedId = dropZoneId;
						} else {
							newChildren = appendToList(newChildren, dzNode);
							lastInsertedId = dropZoneId;
						}
					}

					if (lastInsertedId) setJustInsertedId(lastInsertedId);
					return { ...prev, children: newChildren };
				});
			} else if (onProvideGroupsForQuickPick) {
				const groups: { id: string; title: string }[] = [];
				const collectGroups = (nodes: EditorNode[]) => {
					for (const n of nodes) {
						if (n.type === 'group') {
							groups.push({ id: n.id, title: n.title });
							collectGroups(n.children);
						}
					}
				};
				collectGroups(doc.children);
				onProvideGroupsForQuickPick(groups, insertHunkCommand.payload);
			}
		}
	}, [insertHunkCommand]);

	// Handle insert multiple missing hunks command
	useEffect(() => {
		if (!insertMultipleHunksCommand || insertMultipleHunksCommand.payloads.length === 0) {
			return;
		}

		applyLocal(prev => {
			const groupId = localId();
			const newGroup: EditorGroupNode = {
				type: 'group',
				id: groupId,
				title: 'Remaining Changes',
				level: 1, // Will be normalized
				children: insertMultipleHunksCommand.payloads.map(payload => ({
					type: 'hunk',
					id: localId(),
					hunk: {
						file: payload.file,
						startLine: payload.startLine,
						endLine: payload.endLine,
						patch: payload.patch,
						previousFile: payload.previousFile,
						baseBlob: payload.baseBlob,
					}
				}))
			};

			setJustInsertedId(groupId);
			return { ...prev, children: appendToList(prev.children, newGroup) };
		});
	}, [insertMultipleHunksCommand]);

	const isMismatch = !!doc.isPR && (
		!activePR ||
		doc.prNumber !== activePR.number ||
		doc.prOwner?.toLowerCase() !== activePR.owner?.toLowerCase() ||
		doc.prRepo?.toLowerCase() !== activePR.repo?.toLowerCase()
	);

	// When the extension host sends an updated document (undo/redo), accept it
	// - unless we just pushed a change ourselves.
	useEffect(() => {
		if (isLocalEdit.current) {
			return;
		}
		// Self-echo: app.tsx re-parses every local push and sets its doc state,
		// which loops back as an initialDoc change. Skip exactly one such echo
		// per push so local node IDs (and any selection state keyed to them)
		// survive the re-parse round-trip.
		if (selfEchoCountRef.current > 0) {
			selfEchoCountRef.current--;
			return;
		}
		if (pendingDocumentSyncTimerRef.current !== undefined) {
			window.clearTimeout(pendingDocumentSyncTimerRef.current);
			pendingDocumentSyncTimerRef.current = undefined;
		}
		setDoc(cloneDoc(initialDoc));
	}, [initialDoc]);

	useEffect(() => {
		setTitleDraft(doc.title);
	}, [doc.title]);

	// Whenever doc changes due to a local edit, serialize and push to the extension host.
	useEffect(() => {
		if (onCodeTourHunksChange) {
			const hunks: HunkReference[] = [];
			function collectHunks(nodes: EditorNode[]) {
				for (const node of nodes) {
					if (node.type === 'hunk') {
						hunks.push(node.hunk);
					} else if (node.type === 'group' && node.children) {
						collectHunks(node.children);
					}
				}
			}
			collectHunks(doc.children);
			onCodeTourHunksChange(hunks);
		}

		if (!isLocalEdit.current) {
			return;
		}
		isLocalEdit.current = false;
		const markdown = serializeDoc(doc);
		if (pendingDocumentSyncTimerRef.current !== undefined) {
			window.clearTimeout(pendingDocumentSyncTimerRef.current);
			pendingDocumentSyncTimerRef.current = undefined;
		}

		// Discrete one-shot edits (e.g. committing a paragraph highlight) set
		// flushImmediateRef so the sync bypasses the typing-friendly 180ms
		// debounce. Without this, a quick Ctrl+S right after a drag-commit
		// races the timer and the saved markdown still has the old highlights.
		if (flushImmediateRef.current) {
			flushImmediateRef.current = false;
			if (lastSyncedMarkdownRef.current !== markdown) {
				lastSyncedMarkdownRef.current = markdown;
				selfEchoCountRef.current++;
				onDocumentChange(markdown);
			}
			return;
		}

		pendingDocumentSyncTimerRef.current = window.setTimeout(() => {
			if (lastSyncedMarkdownRef.current === markdown) {
				return;
			}

			selfEchoCountRef.current++;
			onDocumentChange(markdown);
			lastSyncedMarkdownRef.current = markdown;
			pendingDocumentSyncTimerRef.current = undefined;
		}, 180);
	}, [doc, onDocumentChange, onCodeTourHunksChange]);

	useEffect(() => {
		return () => {
			if (pendingDocumentSyncTimerRef.current !== undefined) {
				window.clearTimeout(pendingDocumentSyncTimerRef.current);
			}
		};
	}, []);

	// Helper: apply a local edit (sets the flag before updating state).
	// Discrete one-shot edits (toggle eye, add/remove node, drop hunk, etc.)
	// pass nothing and sync to the host synchronously, so a quick Ctrl+S never
	// races the debounce. Rapid-fire keystroke edits (text and title typing)
	// pass `{ defer: true }` to keep the 180ms debounce that batches them.
	const applyLocal = useCallback((updater: (prev: EditorDocument) => EditorDocument, options?: { defer?: boolean }) => {
		if (!options?.defer) {
			flushImmediateRef.current = true;
		}
		isLocalEdit.current = true;
		setDoc(updater);
	}, []);

	/* - Title editing ------------------------ */

	const commitTitle = useCallback(() => {
		if (titleDraft === doc.title) {
			return;
		}

		applyLocal(prev => ({ ...prev, title: titleDraft }));
	}, [applyLocal, doc.title, titleDraft]);

	const handleTitleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			commitTitle();
			e.currentTarget.blur();
			return;
		}

		if (e.key === 'Escape') {
			e.preventDefault();
			setTitleDraft(doc.title);
			e.currentTarget.blur();
		}
	}, [commitTitle, doc.title]);

	/* - Group title editing ------------------- */

	const handleGroupTitleCommit = useCallback((id: string, title: string) => {
		applyLocal(prev => ({
			...prev,
			children: updateNodeInList(prev.children, id, n =>
				n.type === 'group' ? { ...n, title } : n
			),
		}));
	}, [applyLocal]);

	const handleToggleDefaultCollapsed = useCallback((id: string) => {
		applyLocal(prev => ({
			...prev,
			children: updateNodeInList(prev.children, id, n => {
				if (n.type !== 'group') {
					return n;
				}
				const next = !n.defaultCollapsed;
				const updated: EditorGroupNode = { ...n };
				if (next) {
					updated.defaultCollapsed = true;
				} else {
					delete updated.defaultCollapsed;
				}
				return updated;
			}),
		}));
	}, [applyLocal]);

	const handleToggleHunkDefaultCollapsed = useCallback((id: string) => {
		applyLocal(prev => ({
			...prev,
			children: updateNodeInList(prev.children, id, n => {
				if (n.type !== 'hunk') {
					return n;
				}
				const next = !n.hunk.defaultCollapsed;
				const updatedHunk: HunkReference = { ...n.hunk };
				if (next) {
					updatedHunk.defaultCollapsed = true;
				} else {
					delete updatedHunk.defaultCollapsed;
				}
				return { ...n, hunk: updatedHunk };
			}),
		}));
	}, [applyLocal]);

	/* - Text editing ------------------------- */

	const handleTextChange = useCallback((id: string, content: string) => {
		applyLocal(prev => ({
			...prev,
			children: updateNodeInList(prev.children, id, n =>
				n.type === 'text' ? { ...n, content } : n
			),
		}), { defer: true });
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

	/* - Insert element between siblings ----------- */

	const handleInsertRelative = useCallback(
		(kind: InsertKind, targetId: string, position: DropPosition) => {
			applyLocal(prev => {
				const newId = localId();
				let newNode: EditorNode;
				if (kind === 'text') {
					newNode = { type: 'text', id: newId, content: '' };
				} else if (kind === 'code') {
					newNode = { type: 'dropzone', id: newId };
				} else {
					newNode = {
						type: 'group',
						id: newId,
						title: 'New Section',
						level: 2,
						children: [],
					};
				}
				const result = insertNodeRelative(prev.children, targetId, newNode, position);
				if (!result.inserted) {
					return prev;
				}
				const nextChildren = kind === 'group'
					? normalizeGroupLevels(result.nodes)
					: result.nodes;
				setJustInsertedId(newId);
				return { ...prev, children: nextChildren };
			});
			if (kind === 'code') {
				onRequestChangesOpen?.();
			}
		},
		[applyLocal, onRequestChangesOpen],
	);

	/* - Hunk highlights ------------------------ */

	const handleHighlightsChange = useCallback(
		(hunkId: string, highlights: HighlightRange[]) => {
			flushImmediateRef.current = true;
			applyLocal(prev => ({
				...prev,
				children: updateNodeInList(prev.children, hunkId, n =>
					n.type === 'hunk'
						? { ...n, hunk: { ...n.hunk, highlights: highlights.length > 0 ? highlights : undefined } }
						: n,
				),
			}));
		},
		[applyLocal],
	);

	/* - Hunk summary ------------------------- */

	const handleSummaryChange = useCallback(
		(hunkId: string, summary: string) => {
			applyLocal(prev => ({
				...prev,
				children: updateNodeInList(prev.children, hunkId, n =>
					n.type === 'hunk'
						? { ...n, hunk: { ...n.hunk, summary: summary.trim().length > 0 ? summary : undefined } }
						: n,
				),
			}), { defer: true });
		},
		[applyLocal],
	);

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
		// Surface the diff picker so the user can drag a hunk into the new
		// dropzone without having to manually toggle the changes pane.
		onRequestChangesOpen?.();
	}, [applyLocal, onRequestChangesOpen]);

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
						patch: payload.patch,
						previousFile: payload.previousFile,
						baseBlob: payload.baseBlob,
					},
				})),
			};

			// Bring over PR properties if the document doesn't have them yet.
			// `baseSha` / `headSha` come along too so the future
			// outdated-detection feature has the anchors it needs.
			if (updated.isPR === undefined && payload.isPR !== undefined) {
				updated.isPR = payload.isPR;
				updated.prNumber = payload.prNumber;
				updated.prOwner = payload.prOwner;
				updated.prRepo = payload.prRepo;
				updated.baseRef = payload.baseRef;
				updated.baseSha = payload.baseSha;
				updated.headSha = payload.headSha;
				if (updated.schemaVersion === undefined) {
					updated.schemaVersion = 1;
				}
			}

			return updated;
		});
	}, [applyLocal]);

	// Validate that a dropped hunk payload comes from the same PR the tour is
	// bound to. Returns true on success, surfaces an error on mismatch.
	const validateHunkPayloadPR = useCallback((payload: HunkPayload): boolean => {
		if (!doc.isPR) {
			return true;
		}
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
			return false;
		}
		return true;
	}, [doc.isPR, doc.prNumber, doc.prOwner, doc.prRepo, onError]);

	// Insert a dropped hunk payload immediately before/after a specific node,
	// matching the fine-grained drop indicator the reorder UI already uses.
	// The caller (NodeShell) handles the drop-position display; we just
	// apply the insertion at the requested spot.
	const handleHunkDropAtNode = useCallback((payload: HunkPayload, targetId: string, position: DropPosition) => {
		if (!validateHunkPayloadPR(payload)) {
			return;
		}
		applyLocal(prev => {
			const newId = localId();
			const hunkNode: EditorHunkNode = {
				type: 'hunk',
				id: newId,
				hunk: {
					file: payload.file,
					startLine: payload.startLine,
					endLine: payload.endLine,
					patch: payload.patch,
					previousFile: payload.previousFile,
					baseBlob: payload.baseBlob,
				},
			};
			const result = insertNodeRelative(prev.children, targetId, hunkNode, position);
			if (!result.inserted) {
				return prev;
			}
			const updated: EditorDocument = { ...prev, children: result.nodes };
			if (updated.isPR === undefined && payload.isPR !== undefined) {
				updated.isPR = payload.isPR;
				updated.prNumber = payload.prNumber;
				updated.prOwner = payload.prOwner;
				updated.prRepo = payload.prRepo;
				updated.baseRef = payload.baseRef;
				updated.baseSha = payload.baseSha;
				updated.headSha = payload.headSha;
				if (updated.schemaVersion === undefined) {
					updated.schemaVersion = 1;
				}
			}
			setJustInsertedId(newId);
			return updated;
		});
	}, [applyLocal, validateHunkPayloadPR]);

	// Append a hunk payload as a new hunk node at the end of the tour root.
	// Used when the user drags from the diff picker without first creating a
	// dropzone - they shouldn't have to set up a landing zone first.
	const handleAppendHunkPayload = useCallback((payload: HunkPayload) => {
		applyLocal(prev => {
			const newId = localId();
			const hunkNode: EditorHunkNode = {
				type: 'hunk',
				id: newId,
				hunk: {
					file: payload.file,
					startLine: payload.startLine,
					endLine: payload.endLine,
					patch: payload.patch,
					previousFile: payload.previousFile,
					baseBlob: payload.baseBlob,
				},
			};
			const updated: EditorDocument = {
				...prev,
				children: appendToList(prev.children, hunkNode),
			};
			if (updated.isPR === undefined && payload.isPR !== undefined) {
				updated.isPR = payload.isPR;
				updated.prNumber = payload.prNumber;
				updated.prOwner = payload.prOwner;
				updated.prRepo = payload.prRepo;
				updated.baseRef = payload.baseRef;
				updated.baseSha = payload.baseSha;
				updated.headSha = payload.headSha;
				if (updated.schemaVersion === undefined) {
					updated.schemaVersion = 1;
				}
			}
			setJustInsertedId(newId);
			return updated;
		});
	}, [applyLocal]);

	// Drop target on the tour body itself: lets the user drag a hunk from the
	// changes picker and drop it anywhere in the empty tour area, not just on
	// an existing dropzone. DropZoneBlock's own handler runs first (it calls
	// e.stopPropagation), so this only fires for drops outside a dropzone.
	const [tourBodyDropActive, setTourBodyDropActive] = useState(false);
	// When the user drops on a child NodeShell (fine-grained insert), that
	// drop handler stopPropagation()s, so the body's `onDrop` never fires and
	// the dashed body outline sticks around. Listen at the window level for
	// any drag-end / drop while the outline is showing and clear the state
	// no matter which target finally received the release.
	useEffect(() => {
		if (!tourBodyDropActive) {
			return;
		}
		const clear = () => setTourBodyDropActive(false);
		window.addEventListener('dragend', clear);
		window.addEventListener('drop', clear, true);
		return () => {
			window.removeEventListener('dragend', clear);
			window.removeEventListener('drop', clear, true);
		};
	}, [tourBodyDropActive]);
	const handleTourBodyDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
		if (!isEditMode) {
			return;
		}
		if (!e.dataTransfer.types.includes(HUNK_MIME_TYPE)) {
			return;
		}
		e.preventDefault();
		e.dataTransfer.dropEffect = 'copy';
		setTourBodyDropActive(true);
	}, [isEditMode]);
	const handleTourBodyDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
		const relatedTarget = e.relatedTarget;
		if (relatedTarget instanceof Node && e.currentTarget.contains(relatedTarget)) {
			return;
		}
		setTourBodyDropActive(false);
	}, []);
	const handleTourBodyDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
		if (!isEditMode) {
			return;
		}
		if (!e.dataTransfer.types.includes(HUNK_MIME_TYPE)) {
			return;
		}
		e.preventDefault();
		setTourBodyDropActive(false);
		const raw = e.dataTransfer.getData(HUNK_MIME_TYPE);
		if (!raw) {
			return;
		}
		try {
			const payload: HunkPayload = JSON.parse(raw);
			if (!validateHunkPayloadPR(payload)) {
				return;
			}
			handleAppendHunkPayload(payload);
		} catch {
			// ignore malformed data
		}
	}, [isEditMode, validateHunkPayloadPR, handleAppendHunkPayload]);

	return (
		<div ref={editorRootRef} className={`code-tour-editor${isEditMode ? ' is-edit-mode' : ''}`}>
			{assistantStatus?.running && (
				<div className="tour-assistant-streaming" role="status" aria-live="polite">
					<span className="tour-assistant-streaming-icon">{sparkleIcon}</span>
					<span className="tour-assistant-streaming-label">{assistantStatus.label ?? 'Working…'}</span>
					{onCancelAssistant && (
						<button
							type="button"
							className="tour-action-btn icon-button tour-assistant-stop-button"
							title="Stop the AI assistant"
							onClick={onCancelAssistant}
						>
							{stopCircleIcon}
						</button>
					)}
				</div>
			)}
			{assistantStatus?.error && !assistantStatus.running && (
				<div className="tour-assistant-error" role="alert">
					<span>⚠️ {assistantStatus.error}</span>
					{onDismissAssistantError && (
						<button
							type="button"
							className="tour-action-btn icon-button"
							title="Dismiss"
							onClick={onDismissAssistantError}
						>
							×
						</button>
					)}
				</div>
			)}
			{isMismatch && (
				<div className="tour-pr-warning">
					<span>This Change Tour belongs to PR #{doc.prNumber}. "GoTo Diff" is unavailable until the PR is checked out.</span>
					{onCheckoutPR && (
						<button className="tour-action-btn" onClick={onCheckoutPR}>
							Checkout PR
						</button>
					)}
				</div>
			)}
			{isEditMode ? (
				<input
					className="tour-title-input"
					value={titleDraft}
					onChange={e => setTitleDraft(e.target.value)}
					onBlur={commitTitle}
					onKeyDown={handleTitleKeyDown}
					onFocus={e => {
						// "Untitled Change Tour" is the parser's fallback for tours
						// that never got a real title; auto-select on focus so the
						// next keystroke replaces it.
						if (e.target.value === 'Untitled Change Tour') {
							e.target.select();
						}
					}}
					placeholder="Change Tour Title"
				/>
			) : (
				<h1 className="tour-title-readonly">{doc.title || 'Untitled Change Tour'}</h1>
			)}
			<div
				className={`tour-body${tourBodyDropActive ? ' tour-body-drop-active' : ''}`}
				onDragOver={isEditMode ? handleTourBodyDragOver : undefined}
				onDragLeave={isEditMode ? handleTourBodyDragLeave : undefined}
				onDrop={isEditMode ? handleTourBodyDrop : undefined}
			>
				{doc.children.map(node => (
					<React.Fragment key={node.id}>
						{isEditMode && (
							<InsertGap
								parentLevel={1}
								onInsert={kind => handleInsertRelative(kind, node.id, 'before')}
							/>
						)}
						<NodeRenderer
							node={node}
							doc={doc}
							dragState={dragState} isExternalHunkDragActive={externalHunkDragActive}
							activeNodeId={activeNodeId}
							onActiveNodeChanged={setActiveNodeId}
							onNodeDragStart={handleNodeDragStart}
							onNodeDragEnd={handleNodeDragEnd}
							onReorder={handleReorder}
							onMoveToGroupEnd={handleMoveToGroupEnd}
							onTextChange={handleTextChange}
							onGroupTitleCommit={handleGroupTitleCommit}
							onToggleDefaultCollapsed={handleToggleDefaultCollapsed}
							onToggleHunkDefaultCollapsed={handleToggleHunkDefaultCollapsed}
							onDropZoneDrop={handleDropZoneDrop}
							onHunkDropAtNode={handleHunkDropAtNode}
							onAddText={handleAddText}
							onAddCode={handleAddCode}
							onAddGroup={handleAddGroup}
							onInsertRelative={handleInsertRelative}
							onHighlightsChange={handleHighlightsChange}
							onSummaryChange={handleSummaryChange}
							onRemove={handleRemove}
							onOpenDiff={onOpenDiff}
							activePR={activePR}
							isEditMode={isEditMode}
							diffLayout={diffLayout}
							onError={onError}
							onRunAssistant={onRunAssistant}
							assistantRunning={!!assistantStatus?.running}
						/>
					</React.Fragment>
				))}
				{isEditMode && (
					<div className="tour-root-actions">
						<button className="tour-add-btn icon-button" title="Add text" onClick={() => handleAddText()}>{symbolStringIcon}</button>
						<button className="tour-add-btn icon-button" title="Add diff" onClick={() => handleAddCode()}>{codeIcon}</button>
						<button className="tour-add-btn icon-button" title="Add section" onClick={() => handleAddGroup()}>{newCollectionIcon}</button>
						{onRunAssistant && (
							<button
								className="tour-add-btn icon-button tour-assistant-button"
								title={
									!doc.isPR || !doc.prNumber
										? 'Bind the tour to a pull request (via "Pull Request: New Change Tour") to enable AI generation'
										: 'Auto-generate the full Change Tour with AI'
								}
								disabled={!doc.isPR || !doc.prNumber || !!assistantStatus?.running}
								onClick={() => onRunAssistant('autoGenerate')}
							>
								{sparkleIcon}
							</button>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
