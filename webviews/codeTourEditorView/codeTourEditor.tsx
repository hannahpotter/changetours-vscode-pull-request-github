/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as marked from 'marked';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { computeNewInPrCount, computeOutdatedHunks, editContentFingerprint, findShiftOnlyMatches, indexPrState, type PrState, suggestUpdateCandidateIdx } from './viewerModel';
import { type CodeTourDocument, type ExcludedHunkMarker, findMarkersMatchingHunk, type HighlightRange, type HunkReference, isExactRangeMarker, isGlob, matchesGlob, serializeCodeTourMarkdown, type TourNode, type TourTextNode } from '../../src/github/codeTourMarkdown';
import { appendNodeToGroupEnd, DropPosition, insertNodeRelative, moveNodeRelative, moveNodeToGroupEnd, normalizeGroupLevels } from '../../src/github/codeTourTreeHelpers';
import type { ChangeTourChangesData } from '../../src/github/views';
import { indicesFromHighlights } from '../common/diffHighlights';
import { DiffTable } from '../common/DiffTable';
import  { getHunkSummary, type ParsedDiffLine, parsePatch } from '../common/diffUtils';
import { Tooltip } from '../common/tooltip';
import { addIcon, checkIcon, chevronDownIcon, closeIcon, codeIcon, copilotIcon, diffSingleIcon, editIcon, eyeClosedIcon, foldIcon, gripperIcon, newCollectionIcon, pinnedIcon, sparkleIcon, stopCircleIcon, symbolStringIcon, syncIcon, terminalIcon, trashIcon, unfoldIcon, unpinIcon} from '../components/icon';

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

/**
 * Narration "group" the active node belongs to - the selected paragraph
 * plus the contiguous run of hunk siblings that immediately follow it
 * (same forward-walk rule the viewer applies on paragraph-click in view
 * mode; see `viewerModel.ts#associatedHunkIds`).
 *
 *   - `members` is the set of node ids in the group (paragraph + hunks).
 *   - `lastId` is the id of the visually-bottommost member, used to stop
 *     the connecting marker so it doesn't protrude past the last hunk.
 *
 * Activating a *hunk* that sits inside a run keeps the same group lit by
 * walking backward to the preceding paragraph - otherwise clicking a hunk
 * after clicking its intro paragraph would dismiss the highlight (the
 * "weird flicker" we want to avoid).
 */
interface NarrationGroup {
	members: Set<string>;
	lastId: string | undefined;
}

function findNarrationGroup(children: ReadonlyArray<EditorNode>, activeId: string): NarrationGroup {
	const empty: NarrationGroup = { members: new Set(), lastId: undefined };
	const fromTextAt = (siblings: ReadonlyArray<EditorNode>, textIdx: number): NarrationGroup => {
		const members = new Set<string>();
		const text = siblings[textIdx];
		members.add(text.id);
		let lastId: string = text.id;
		for (let j = textIdx + 1; j < siblings.length; j++) {
			const sib = siblings[j];
			if (sib.type === 'hunk') {
				members.add(sib.id);
				lastId = sib.id;
			} else {
				break;
			}
		}
		return { members, lastId };
	};
	const visit = (siblings: ReadonlyArray<EditorNode>): NarrationGroup | undefined => {
		for (let i = 0; i < siblings.length; i++) {
			const cur = siblings[i];
			if (cur.id === activeId) {
				if (cur.type === 'text') {
					return fromTextAt(siblings, i);
				}
				if (cur.type === 'hunk') {
					// Walk backward through contiguous hunks to find the
					// intro paragraph that owns this run. If we hit a
					// non-text non-hunk (group / dropzone), the active
					// hunk has no intro and no group lights up.
					for (let j = i - 1; j >= 0; j--) {
						const sib = siblings[j];
						if (sib.type === 'text') {
							return fromTextAt(siblings, j);
						}
						if (sib.type !== 'hunk') {
							break;
						}
					}
					return empty;
				}
				return empty;
			}
			if (cur.type === 'group') {
				const found = visit(cur.children);
				if (found) {
					return found;
				}
			}
		}
		return undefined;
	};
	return visit(children) ?? empty;
}

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
	baseSha?: string;
	headSha?: string;
	children: EditorNode[];
	/**
	 * Parsed `<!-- changetour:exclude ... -->` markers. Carried through the
	 * editor state so the Excluded outline section stays in sync with edits
	 * that add or remove markers (the editor reads from `doc.exclusions`
	 * rather than re-scanning the serialized markdown).
	 */
	exclusions?: ExcludedHunkMarker[];
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
	onRunAssistant?: (mode: 'autoGenerate' | 'narrateHunk' | 'improveSection' | 'summarizeHunk' | 'updateTour' | 'refreshHunkNarration', ctx?: { hunkId?: string; groupId?: string }) => void;
	onCancelAssistant?: () => void;
	onDismissAssistantError?: () => void;
	/** PR state snapshot used for outdated-hunk detection. */
	prState?: PrState;
	/** Trigger a fresh PR-state fetch (Refresh button in the outdated banner). */
	onRefreshPrState?: () => void;
	/** Open a terminal seeded with `claude "Use the change-tour skill to update @<path> …"`. */
	onUpdateWithClaudeCode?: () => void;
	/** Open Copilot Chat pre-populated with `@change-tour /update`. */
	onUpdateWithCopilotChat?: () => void;
	/**
	 * Snapshot of the bound PR's file changes (the same `changesData` the
	 * Changes overview consumes). Used by the editor's Excluded outline
	 * section to resolve `<!-- changetour:exclude ... -->` markers into real
	 * PR hunks so the "Open diff" button can open the right file/range.
	 */
	changesData?: ChangeTourChangesData;
	/**
	 * Remove a `<!-- changetour:exclude ... -->` marker. Exact-range markers
	 * pass both bounds; whole-file or glob markers pass undefined for both.
	 * Provider matches against the on-disk attribute shape.
	 */
	onRemoveExclusion?: (file: string, startLine?: number, endLine?: number) => void;
	/**
	 * Open the diff for an excluded marker. The webview pre-resolves the list
	 * of candidate `HunkReference`s from `changesData`; the provider shows a
	 * quickpick when there's more than one (whole-file / glob markers can
	 * match many hunks).
	 */
	onOpenExcludedDiff?: (hunks: HunkReference[], target: string) => void;
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

/**
 * Stable, parser-independent fingerprint for a tour node. The Change Tour
 * parser regenerates `id` on every parse, so we can't compare snapshots by
 * id. The fingerprint is shaped so it survives a serialize → parse round-trip
 * and uniquely identifies a node based on its meaningful content:
 *   - hunk: file + new-side line range + optional rename source
 *   - text: trimmed prose content (text IS its identity)
 *   - group: full ancestor path + title + level
 *
 * Used by the AI-review diff to compute "node IDs the AI just added" by
 * walking both the pre-AI snapshot and the current doc and finding nodes
 * whose fingerprint is present now but wasn't before.
 */
function nodeFingerprint(node: EditorNode, parentPath: string): string {
	switch (node.type) {
		case 'hunk':
			return `hunk@${parentPath}|${node.hunk.file}|${node.hunk.startLine}-${node.hunk.endLine}|${node.hunk.previousFile ?? ''}`;
		case 'text':
			return `text@${parentPath}|${node.content.trim()}`;
		case 'group':
			return `group@${parentPath}|${node.title}|${node.level}`;
		case 'dropzone':
		default:
			return `dropzone@${parentPath}|${node.id}`;
	}
}

function collectFingerprints(children: EditorNode[]): Set<string> {
	const out = new Set<string>();
	const walk = (nodes: EditorNode[], parentPath: string) => {
		for (const n of nodes) {
			out.add(nodeFingerprint(n, parentPath));
			if (n.type === 'group') {
				walk(n.children, `${parentPath}/${n.title}`);
			}
		}
	};
	walk(children, '');
	return out;
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
		baseSha: doc.baseSha,
		headSha: doc.headSha,
		children: editorNodesToTourNodes(doc.children),
		// Carry exclusions through the round-trip. The serializer re-emits the
		// `## Excluded Changes` appendix from this field (the parser stripped
		// it from `children`), so without forwarding it here every local edit
		// in the webview would silently drop every marker on save.
		exclusions: doc.exclusions,
	};
	return serializeCodeTourMarkdown(tourDoc);
}

/* - Drop zone block (pending hunk placeholder) ----------- */

// Extended payload from drag that may include patch content
interface HunkPayload extends HunkReference {
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
	isAiAdded,
	isAssociated,
	isLastInNarrationGroup,
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
	/** True when the node was added by the AI in the current review session. Adds the highlight class. */
	isAiAdded?: boolean;
	/** True when this node (paragraph OR claimed hunk) is part of the active narration group. Paints the blue left-edge accent. */
	isAssociated?: boolean;
	/** True when this node is the visually-bottommost member of the narration group. Stops the connecting marker so it doesn't extend past the last hunk. */
	isLastInNarrationGroup?: boolean;
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
				activeNodeId === node.id ? 'tour-node-active' : '',
				isAiAdded ? 'tour-node-ai-added' : ''
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
			{/* Narration-association bar. Rendered as a real element (the shell's
			 * `::before`/`::after` pseudos are reserved for drag-drop indicators)
			 * AND positioned in the empty 4px gutter between the drag handle
			 * (left: 0-22px) and the content (left: 28px) so HTML5 drag hit-
			 * testing on the gripper never gets shadowed by this element. */}
			{isAssociated && (
				<span
					className={`tour-node-association-marker${isLastInNarrationGroup ? ' tour-node-association-marker-last' : ''}`}
					aria-hidden="true"
				/>
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

				if (doc.prNumber !== undefined) {
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
			<Tooltip text="Remove drop zone">
				<button
					className="tour-remove-btn tour-text-remove icon-button"
					onClick={() => onRemove(node.id)}
				>
					{trashIcon}
				</button>
			</Tooltip>
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
	node: realNode,
	doc,
	onRemove,
	onOpenDiff,
	onHighlightsChange,
	onSummaryChange,
	onToggleHunkDefaultCollapsed,
	onTogglePinned,
	activePR,
	isEditMode,
	diffLayout,
	onRunAssistant,
	assistantRunning,
	isDragging,
	isOutdated,
	pendingProposed,
	canAutoUpdate,
	onStageAutoUpdate,
	onConfirmAutoUpdate,
	onDiscardAutoUpdate,
	autoUpdateCandidates,
	suggestedAutoUpdateIdx,
	pickerOpen,
	onCancelAutoUpdatePick,
}: {
	node: EditorHunkNode;
	doc: EditorDocument;
	onRemove: (id: string) => void;
	onOpenDiff?: (hunk: HunkReference) => void;
	onHighlightsChange?: (hunkId: string, highlights: HighlightRange[]) => void;
	onSummaryChange?: (hunkId: string, summary: string) => void;
	onToggleHunkDefaultCollapsed: (id: string) => void;
	/** Toggle the hunk's `pinned` flag. Only meaningful when isOutdated is true. */
	onTogglePinned?: (id: string) => void;
	activePR?: { number: number; owner: string; repo: string };
	isEditMode: boolean;
	diffLayout: 'inline' | 'sideBySide';
	onRunAssistant?: (mode: 'autoGenerate' | 'narrateHunk' | 'improveSection' | 'summarizeHunk' | 'updateTour' | 'refreshHunkNarration', ctx?: { hunkId?: string; groupId?: string }) => void;
	assistantRunning?: boolean;
	isDragging?: boolean;
	/** True when this hunk's underlying file has drifted from `baseBlob`. */
	isOutdated?: boolean;
	/** When present, render the proposed (staged) hunk instead of the doc's stored hunk. */
	pendingProposed?: HunkReference;
	/** True when the per-hunk "Update" button should appear (file is present in the current PR diff). */
	canAutoUpdate?: boolean;
	onStageAutoUpdate?: (id: string, candidateIdx?: number, refreshNarration?: boolean) => void;
	onConfirmAutoUpdate?: (id: string) => void;
	onDiscardAutoUpdate?: (id: string) => void;
	/** Candidate current-PR hunks for the file backing this hunk; used by the picker. */
	autoUpdateCandidates?: Array<{ startLine: number; endLine: number; patch: string }>;
	/** Index of the candidate the heuristic recommends (old-side range match, new-side overlap tiebreaker). Renders with a "Suggested" badge inside the picker. */
	suggestedAutoUpdateIdx?: number;
	/** True when the per-hunk picker for ambiguous auto-update should render inline. */
	pickerOpen?: boolean;
	onCancelAutoUpdatePick?: () => void;
}) {
	// Render against the proposed hunk when an auto-update is staged. The doc
	// tree itself stays unchanged until the author hits Confirm; the proposed
	// patch is purely an overlay until then.
	const node: EditorHunkNode = pendingProposed
		? { ...realNode, hunk: pendingProposed }
		: realNode;
	const hasPendingUpdate = !!pendingProposed;
	const { file, startLine, endLine, patch } = node.hunk;
	const headShaShort = doc.headSha ? doc.headSha.substring(0, 7) : '';
	const lines = useMemo(() => patch ? parsePatch(patch) : [], [patch]);
	const summaryInfo = useMemo(() => getHunkSummary(node.hunk), [node.hunk]);

	const isMismatch = doc.prNumber !== undefined && (
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
	// Local toggle for the auto-update picker's "refresh narration" choice.
	// Persists across re-renders so users don't have to re-check it if they
	// open/close the picker. Default ON: most updates that warrant patch
	// replacement also want adjacent prose to reflect the new behavior.
	const [autoUpdateRefreshNarration, setAutoUpdateRefreshNarration] = useState(true);
	// Selected candidate index in the auto-update picker dropdown. Seeded
	// from the heuristic Suggested index (so a quick Enter on Stage takes
	// the recommendation) and re-syncs whenever the suggestion changes or
	// the picker is reopened on a different hunk.
	const [pickerSelectedIdx, setPickerSelectedIdx] = useState(0);
	useEffect(() => {
		setPickerSelectedIdx(suggestedAutoUpdateIdx ?? 0);
	}, [suggestedAutoUpdateIdx, pickerOpen]);

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

	// While an EXTERNAL hunk drag is active (dragging a hunk in from the
	// changes picker), collapse the diff body so the tour reads as a stack
	// of summary-only cards - drop targets are easy to find regardless of
	// how long each hunk's diff is. The body restores automatically when
	// the drag ends and `isDragging` flips back to false.
	//
	// Critically, this is NOT applied during in-tour reorder drags: that
	// would mass-collapse hunks at the moment dragstart fires, snapping any
	// node-shell below a hunk hundreds of pixels upward and yanking the
	// drag source out from under the cursor. Chromium then silently aborts
	// the drag, producing the "I can't drag any node after a hunk" bug.
	// `isDragging` is wired to `isExternalHunkDragActive` only at the call
	// site for this reason.
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
						{hasPendingUpdate && (
							<span className="tour-hunk-pending-pill" title="A proposed update is staged. Apply with the check button or discard with the close button.">
								<span className="tour-hunk-badge tour-hunk-badge-draft">
									{/* allow-any-unicode-next-line */}
									Auto-updated · pending
								</span>
								{isEditMode && onConfirmAutoUpdate && (
									<Tooltip text="Apply this proposed update to the tour and save the file">
										<button
											type="button"
											className="tour-hunk-pending-pill-btn tour-auto-update-confirm"
											onClick={() => onConfirmAutoUpdate(realNode.id)}
										>
											{checkIcon}
										</button>
									</Tooltip>
								)}
								{isEditMode && onDiscardAutoUpdate && (
									<Tooltip text="Discard this proposed update; the tour stays unchanged">
										<button
											type="button"
											className="tour-hunk-pending-pill-btn tour-auto-update-discard"
											onClick={() => onDiscardAutoUpdate(realNode.id)}
										>
											{closeIcon}
										</button>
									</Tooltip>
								)}
							</span>
						)}
						{!hasPendingUpdate && isOutdated && realNode.hunk.pinned && (
							<span className="tour-hunk-badge tour-hunk-badge-pinned" title="This hunk's file has drifted from the PR. The author pinned it as history (the tour is not flagged outdated because of this hunk).">
								History (Pinned)
							</span>
						)}
						{!hasPendingUpdate && isOutdated && !realNode.hunk.pinned && (
							<span className="tour-hunk-badge tour-hunk-badge-outdated" title="This hunk's file has drifted from the PR since the tour was authored. Click the pin button to keep it as history; click the update button to refresh it.">
								Outdated
							</span>
						)}
					</div>
					<div className="tour-hunk-actions">
						{isEditMode && onRunAssistant && (
							<Tooltip text="Draft narration for this hunk with AI">
								<button
									type="button"
									className="tour-action-btn icon-button tour-assistant-button"
									disabled={!!assistantRunning}
									onClick={() => onRunAssistant('narrateHunk', { hunkId: node.id })}
								>
									{sparkleIcon}
								</button>
							</Tooltip>
						)}
						{highlightEditingEnabled && (
							<Tooltip text={highlightMode ? 'Exit highlight mode' : 'Highlight lines (drag in the diff)'}>
								<button
									type="button"
									className={`tour-action-btn icon-button tour-hunk-highlight-toggle${highlightMode ? ' active' : ''}`}
									aria-pressed={highlightMode}
									onClick={() => setHighlightMode(m => !m)}
								>
									{editIcon}
								</button>
							</Tooltip>
						)}
						{isEditMode && (
							<Tooltip text={node.hunk.defaultCollapsed
								? "Viewer won't see this hunk expanded by default - click to make viewer see it by default"
								: 'Viewer sees this hunk expanded by default - click to make viewer not see it by default'}>
								<button
									type="button"
									className={`tour-action-btn icon-button tour-default-collapsed-toggle${node.hunk.defaultCollapsed ? ' active' : ''}`}
									aria-pressed={!!node.hunk.defaultCollapsed}
									onClick={() => onToggleHunkDefaultCollapsed(node.id)}
								>
									{node.hunk.defaultCollapsed ? unfoldIcon : foldIcon}
								</button>
							</Tooltip>
						)}
						{isEditMode && isOutdated && !hasPendingUpdate && onTogglePinned && (
							<Tooltip text={realNode.hunk.pinned
								? 'Stop keeping this hunk as history (re-enable outdated detection for this hunk)'
								: "Keep this hunk as history (don't flag the tour as outdated for this hunk)"}>
								<button
									type="button"
									className={`tour-action-btn icon-button tour-pin-toggle${realNode.hunk.pinned ? ' active' : ''}`}
									aria-pressed={!!realNode.hunk.pinned}
									onClick={() => onTogglePinned(realNode.id)}
								>
									{realNode.hunk.pinned ? unpinIcon : pinnedIcon}
								</button>
							</Tooltip>
						)}
						{isEditMode && canAutoUpdate && !hasPendingUpdate && onStageAutoUpdate && (
							<Tooltip text="Stage a proposed update to the current PR patch for this file. Review then Confirm to save, or Undo to discard.">
								<button
									type="button"
									className="tour-action-btn icon-button tour-auto-update-stage"
									onClick={() => onStageAutoUpdate(realNode.id)}
								>
									{syncIcon}
								</button>
							</Tooltip>
						)}
						{/* The standalone "refresh narration" sparkle is gone - the decision is made inside the picker BEFORE staging (see the autoUpdateRefreshNarration toggle). Keeping the option in the picker means the AI only fires when the author explicitly asks for it, and it fires together with the patch stage instead of being a separate manual step after. */}
						{onOpenDiff && (
							<Tooltip text={isMismatch ? 'Checkout the associated PR to open in file context' : 'Open in file context'}>
								<button
									className="tour-action-btn icon-button"
									disabled={isMismatch}
									onClick={() => onOpenDiff(node.hunk)}
								>
									{diffSingleIcon}
								</button>
							</Tooltip>
						)}
						{isEditMode && (
							<Tooltip text="Remove hunk">
								<button className="tour-remove-btn tour-action-btn icon-button" onClick={() => onRemove(node.id)}>
									{trashIcon}
								</button>
							</Tooltip>
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
								<Tooltip text="Draft a one-line summary for this hunk with AI">
									<button
										type="button"
										className="tour-action-btn icon-button tour-assistant-button tour-hunk-summary-sparkle"
										disabled={!!assistantRunning}
										onClick={() => onRunAssistant('summarizeHunk', { hunkId: node.id })}
									>
										{sparkleIcon}
									</button>
								</Tooltip>
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
				{/* Ambiguity picker for auto-update: shown when the user clicked the Update button on a hunk whose file has multiple current PR hunks. Each candidate's new-side line range is the click target; the patch text feeds the stage handler. */}
				{pickerOpen && autoUpdateCandidates && autoUpdateCandidates.length > 0 && onStageAutoUpdate && (
					<div className="tour-hunk-autoupdate-picker">
						<span className="tour-hunk-autoupdate-picker-label">
							{autoUpdateCandidates.length === 1
								? 'Stage the current PR hunk as the replacement?'
								: `This file has ${autoUpdateCandidates.length} hunks in the PR. Which should replace this one?`}
						</span>
						<div className="tour-hunk-autoupdate-picker-options">
							{autoUpdateCandidates.length === 1 ? (
								<Tooltip text={autoUpdateCandidates[0].patch.split('\n').slice(0, 6).join('\n')}>
									<button
										type="button"
										className={`tour-action-btn${suggestedAutoUpdateIdx === 0 ? ' tour-action-btn-suggested' : ''}`}
										onClick={() => onStageAutoUpdate(realNode.id, 0, autoUpdateRefreshNarration)}
									>
										Stage L{autoUpdateCandidates[0].startLine}&ndash;{autoUpdateCandidates[0].endLine}
									</button>
								</Tooltip>
							) : (
								<>
									{/* Dropdown scales to N candidates without spilling the picker row. The Suggested candidate is preselected so a quick Enter on the Stage button takes the heuristic recommendation. The select keeps its native title - <select> isn't a custom-tooltip use case (the native dropdown's interactions don't suffer the title-cache issue the way action buttons do). */}
									<select
										className="tour-hunk-autoupdate-picker-select"
										value={pickerSelectedIdx}
										onChange={e => setPickerSelectedIdx(parseInt(e.target.value, 10))}
										title={autoUpdateCandidates[pickerSelectedIdx]?.patch.split('\n').slice(0, 8).join('\n')}
									>
										{autoUpdateCandidates.map((c, idx) => (
											<option key={idx} value={idx}>
												L{c.startLine}&ndash;{c.endLine}{suggestedAutoUpdateIdx === idx ? ' (Suggested)' : ''}
											</option>
										))}
									</select>
									<Tooltip text="Stage the selected hunk as the replacement">
										<button
											type="button"
											className="tour-action-btn"
											onClick={() => onStageAutoUpdate(realNode.id, pickerSelectedIdx, autoUpdateRefreshNarration)}
										>
											Stage
										</button>
									</Tooltip>
								</>
							)}
							{onCancelAutoUpdatePick && (
								<Tooltip text="Close without picking">
									<button
										type="button"
										className="tour-action-btn"
										onClick={onCancelAutoUpdatePick}
									>
										Cancel
									</button>
								</Tooltip>
							)}
						</div>
						{onRunAssistant && (
							<label className="tour-hunk-autoupdate-picker-narration" title="When checked, the AI assistant rewrites adjacent text nodes to match the new hunk content after staging. Narration changes apply directly to the doc; the patch swap is still staged for Confirm / Discard.">
								<span className="checkbox-wrapper">
									<input
										type="checkbox"
										checked={autoUpdateRefreshNarration}
										onChange={e => setAutoUpdateRefreshNarration(e.target.checked)}
									/>
								</span>
								<span>Refresh narration with AI</span>
							</label>
						)}
					</div>
				)}
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
			// `preventScroll: true` keeps the browser from auto-scrolling the
			// textarea into view on focus. Without it, the first click on a
			// paragraph causes a visible vertical shift right as the rendered
			// HTML swaps for the textarea - reads as a "flicker" even though
			// the underlying layout box is roughly the same size.
			textareaRef.current?.focus({ preventScroll: true });
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
				<Tooltip text="Remove text block">
					<button
						className="tour-remove-btn tour-action-btn icon-button"
						onMouseDown={e => { e.preventDefault(); onRemove(node.id); }}
					>
						{trashIcon}
					</button>
				</Tooltip>
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
				<Tooltip text="Remove text block">
					<button
						className="tour-remove-btn tour-action-btn icon-button"
						onClick={() => onRemove(node.id)}
					>
						{trashIcon}
					</button>
				</Tooltip>
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
	outdatedHunkIds,
	onTogglePinned,
	pendingUpdates,
	autoUpdateAvailableNodeIds,
	onStageAutoUpdate,
	onConfirmAutoUpdate,
	onDiscardAutoUpdate,
	prStateIndex,
	pickerOpenFor,
	onCancelAutoUpdatePick,
	aiAddedNodeIds,
	narrationGroup,
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
	onRunAssistant?: (mode: 'autoGenerate' | 'narrateHunk' | 'improveSection' | 'summarizeHunk' | 'updateTour' | 'refreshHunkNarration', ctx?: { hunkId?: string; groupId?: string }) => void;
	assistantRunning?: boolean;
	outdatedHunkIds?: Set<string>;
	onTogglePinned?: (id: string) => void;
	pendingUpdates?: Map<string, { proposed: HunkReference; original: HunkReference }>;
	autoUpdateAvailableNodeIds?: Set<string>;
	onStageAutoUpdate?: (id: string, candidateIdx?: number, refreshNarration?: boolean) => void;
	onConfirmAutoUpdate?: (id: string) => void;
	onDiscardAutoUpdate?: (id: string) => void;
	prStateIndex?: { hunksByFile: Map<string, Array<{ startLine: number; endLine: number; patch: string }>>; blobsByFile: Map<string, string>; renamedFrom: Map<string, string> };
	pickerOpenFor?: string;
	onCancelAutoUpdatePick?: () => void;
	aiAddedNodeIds?: Set<string>;
	/** Hunk node ids associated with the currently-active text node (forward-walk siblings). Drives the on-selection blue left-edge accent. */
	narrationGroup?: NarrationGroup;
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
					<Tooltip text={node.defaultCollapsed
						? "Viewer won't see this section expanded by default - click to make viewer see it by default"
						: 'Viewer sees this section expanded by default - click to make viewer not see it by default'}>
						<button
							type="button"
							className={`tour-action-btn icon-button tour-default-collapsed-toggle${node.defaultCollapsed ? ' active' : ''}`}
							aria-pressed={!!node.defaultCollapsed}
							onClick={() => onToggleDefaultCollapsed(node.id)}
						>
							{node.defaultCollapsed ? unfoldIcon : foldIcon}
						</button>
					</Tooltip>
				)}
				{isEditMode && onRunAssistant && (
					<Tooltip text="Improve this section with AI">
						<button
							type="button"
							className="tour-action-btn icon-button tour-assistant-button"
							disabled={!!assistantRunning}
							onClick={() => onRunAssistant('improveSection', { groupId: node.id })}
						>
							{sparkleIcon}
						</button>
					</Tooltip>
				)}
				{isEditMode && (
					<Tooltip text="Remove section">
						<button className="tour-remove-btn icon-button" onClick={() => onRemove(node.id)}>
							{trashIcon}
						</button>
					</Tooltip>
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
									dragState={dragState}
									dropTargetId={child.id}
									onReorder={onReorder}
									onHunkDropAtNode={onHunkDropAtNode}
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
								outdatedHunkIds={outdatedHunkIds}
								onTogglePinned={onTogglePinned}
								pendingUpdates={pendingUpdates}
								autoUpdateAvailableNodeIds={autoUpdateAvailableNodeIds}
								onStageAutoUpdate={onStageAutoUpdate}
								onConfirmAutoUpdate={onConfirmAutoUpdate}
								onDiscardAutoUpdate={onDiscardAutoUpdate}
								prStateIndex={prStateIndex}
								pickerOpenFor={pickerOpenFor}
								onCancelAutoUpdatePick={onCancelAutoUpdatePick}
								aiAddedNodeIds={aiAddedNodeIds}
								narrationGroup={narrationGroup}
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
							<Tooltip text="Add text">
								<button className="tour-add-btn icon-button" onClick={() => onAddText(node.id)}>{symbolStringIcon}</button>
							</Tooltip>
							<Tooltip text="Add hunk">
								<button className="tour-add-btn icon-button" onClick={() => onAddCode(node.id)}>{codeIcon}</button>
							</Tooltip>
							{node.level < 6 && (
								<Tooltip text="Add section">
									<button className="tour-add-btn icon-button" onClick={() => onAddGroup(node.id)}>{newCollectionIcon}</button>
								</Tooltip>
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
	outdatedHunkIds,
	onTogglePinned,
	pendingUpdates,
	autoUpdateAvailableNodeIds,
	onStageAutoUpdate,
	onConfirmAutoUpdate,
	onDiscardAutoUpdate,
	prStateIndex,
	pickerOpenFor,
	onCancelAutoUpdatePick,
	aiAddedNodeIds,
	narrationGroup,
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
	onRunAssistant?: (mode: 'autoGenerate' | 'narrateHunk' | 'improveSection' | 'summarizeHunk' | 'updateTour' | 'refreshHunkNarration', ctx?: { hunkId?: string; groupId?: string }) => void;
	assistantRunning?: boolean;
	/** Node IDs whose hunk has drifted from `baseBlob` since author time. */
	outdatedHunkIds?: Set<string>;
	/** Toggle a hunk's `pinned` flag (silences outdated detection for it). */
	onTogglePinned?: (id: string) => void;
	/** Staged auto-updates (nodeId → proposed/original snapshot). */
	pendingUpdates?: Map<string, { proposed: HunkReference; original: HunkReference }>;
	/** Hunks where a one-click "Update" is unambiguous (single current PR hunk for the file). */
	autoUpdateAvailableNodeIds?: Set<string>;
	onStageAutoUpdate?: (id: string, candidateIdx?: number, refreshNarration?: boolean) => void;
	onConfirmAutoUpdate?: (id: string) => void;
	onDiscardAutoUpdate?: (id: string) => void;
	/** Indexed PR state (file → list of candidate hunks). Used by the per-hunk picker. */
	prStateIndex?: { hunksByFile: Map<string, Array<{ startLine: number; endLine: number; patch: string }>>; blobsByFile: Map<string, string>; renamedFrom: Map<string, string> };
	/** Node ID whose ambiguous-pick picker is currently open. */
	pickerOpenFor?: string;
	onCancelAutoUpdatePick?: () => void;
	/** Set of node IDs added by the AI in the current review session - drives the per-node highlight. */
	aiAddedNodeIds?: Set<string>;
	/** Hunk node ids associated with the currently-active text node. Each NodeShell uses set-membership to decide whether to paint the blue left-edge accent. */
	narrationGroup?: NarrationGroup;
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
					isAiAdded={aiAddedNodeIds?.has(node.id)}
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
						outdatedHunkIds={outdatedHunkIds}
						onTogglePinned={onTogglePinned}
						pendingUpdates={pendingUpdates}
						autoUpdateAvailableNodeIds={autoUpdateAvailableNodeIds}
						onStageAutoUpdate={onStageAutoUpdate}
						onConfirmAutoUpdate={onConfirmAutoUpdate}
						onDiscardAutoUpdate={onDiscardAutoUpdate}
					prStateIndex={prStateIndex}
						pickerOpenFor={pickerOpenFor}
						onCancelAutoUpdatePick={onCancelAutoUpdatePick}
						aiAddedNodeIds={aiAddedNodeIds}
						narrationGroup={narrationGroup}
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
					isAiAdded={aiAddedNodeIds?.has(node.id)}
					isAssociated={narrationGroup?.members.has(node.id)}
					isLastInNarrationGroup={narrationGroup?.lastId === node.id}
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
					isAiAdded={aiAddedNodeIds?.has(node.id)}
					isAssociated={narrationGroup?.members.has(node.id)}
					isLastInNarrationGroup={narrationGroup?.lastId === node.id}
				>
					{(() => {
						const hunkNode = node as EditorHunkNode;
						const candidates = prStateIndex?.hunksByFile.get(hunkNode.hunk.file);
						const suggestedIdx = candidates && candidates.length > 1
							? suggestUpdateCandidateIdx(hunkNode.hunk, candidates)
							: undefined;
						return (
							<HunkBlock node={hunkNode} doc={doc} onRemove={onRemove} onOpenDiff={onOpenDiff} onHighlightsChange={onHighlightsChange} onSummaryChange={onSummaryChange} onToggleHunkDefaultCollapsed={onToggleHunkDefaultCollapsed} onTogglePinned={onTogglePinned} isOutdated={outdatedHunkIds?.has(node.id)} pendingProposed={pendingUpdates?.get(node.id)?.proposed} canAutoUpdate={autoUpdateAvailableNodeIds?.has(node.id)} onStageAutoUpdate={onStageAutoUpdate} onConfirmAutoUpdate={onConfirmAutoUpdate} onDiscardAutoUpdate={onDiscardAutoUpdate} autoUpdateCandidates={candidates} suggestedAutoUpdateIdx={suggestedIdx} pickerOpen={pickerOpenFor === node.id} onCancelAutoUpdatePick={onCancelAutoUpdatePick} activePR={activePR} isEditMode={isEditMode} diffLayout={diffLayout} onRunAssistant={onRunAssistant} assistantRunning={assistantRunning} isDragging={!!isExternalHunkDragActive} />
						);
					})()}
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
					isAiAdded={aiAddedNodeIds?.has(node.id)}
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
	dragState,
	dropTargetId,
	onReorder,
	onHunkDropAtNode,
}: {
	parentLevel: number;
	onInsert: (kind: InsertKind) => void;
	/** Active in-tour reorder drag, if any. When set, drops in this gap reorder the dragged node to immediately before `dropTargetId`. */
	dragState?: ReorderDragState | null;
	/** The next sibling's id (i.e. the node that this gap sits immediately above). Drops in the gap land "before" this target. */
	dropTargetId?: string;
	onReorder?: (draggedId: string, targetId: string, position: DropPosition) => void;
	/** Forwarder for external hunk drags from the changes picker. */
	onHunkDropAtNode?: (payload: HunkPayload, targetId: string, position: DropPosition) => void;
}) {
	const [open, setOpen] = useState(false);
	const [isDragOver, setIsDragOver] = useState(false);
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

	// Forward drops in the gap to "before the next sibling" so the 12px gap
	// between siblings stops being a dead zone where dragover never preventDefaults
	// (which silently rejects drops landing there). Without this, dropping a
	// node anywhere except cleanly on top of a NodeShell would feel flaky.
	const canAcceptReorder = !!dragState && !!dropTargetId && !!onReorder && dragState.nodeId !== dropTargetId;
	const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
		const isHunkDrag = !dragState && event.dataTransfer.types.includes(HUNK_MIME_TYPE);
		if (!canAcceptReorder && !(isHunkDrag && onHunkDropAtNode && dropTargetId)) {
			return;
		}
		event.preventDefault();
		event.dataTransfer.dropEffect = canAcceptReorder ? 'move' : 'copy';
		setIsDragOver(true);
	}, [canAcceptReorder, dragState, dropTargetId, onHunkDropAtNode]);
	const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
		const relatedTarget = event.relatedTarget;
		if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
			return;
		}
		setIsDragOver(false);
	}, []);
	const handleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
		const isHunkDrag = !dragState && event.dataTransfer.types.includes(HUNK_MIME_TYPE);
		if (!canAcceptReorder && !(isHunkDrag && onHunkDropAtNode && dropTargetId)) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		setIsDragOver(false);
		if (canAcceptReorder && dragState && dropTargetId && onReorder) {
			onReorder(dragState.nodeId, dropTargetId, 'before');
			return;
		}
		if (isHunkDrag && onHunkDropAtNode && dropTargetId) {
			try {
				const raw = event.dataTransfer.getData(HUNK_MIME_TYPE);
				if (raw) {
					const payload = JSON.parse(raw) as HunkPayload;
					onHunkDropAtNode(payload, dropTargetId, 'before');
				}
			} catch {
				// ignore malformed payload
			}
		}
	}, [canAcceptReorder, dragState, dropTargetId, onReorder, onHunkDropAtNode]);

	return (
		<div
			ref={containerRef}
			className={`tour-insert-gap${open ? ' tour-insert-gap-open' : ''}${isDragOver ? ' tour-insert-gap-drag-over' : ''}`}
			onClick={e => e.stopPropagation()}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
			<Tooltip text="Insert element here">
				<button
					type="button"
					className="tour-insert-gap-btn"
					aria-haspopup="menu"
					aria-expanded={open}
					onClick={e => {
						e.stopPropagation();
						setOpen(v => !v);
					}}
				>
					{addIcon}
				</button>
			</Tooltip>
			{open && (
				<div className="tour-insert-gap-menu" role="menu">
					<Tooltip text="Add text">
						<button
							type="button"
							className="tour-add-btn icon-button"
							role="menuitem"
							onClick={() => select('text')}
						>
							{symbolStringIcon}
						</button>
					</Tooltip>
					<Tooltip text="Add hunk">
						<button
							type="button"
							className="tour-add-btn icon-button"
							role="menuitem"
							onClick={() => select('code')}
						>
							{codeIcon}
						</button>
					</Tooltip>
					{parentLevel < 6 && (
						<Tooltip text="Add section">
							<button
								type="button"
								className="tour-add-btn icon-button"
								role="menuitem"
								onClick={() => select('group')}
							>
								{newCollectionIcon}
							</button>
						</Tooltip>
					)}
				</div>
			)}
		</div>
	);
}

/* - Main editor component ---------------------- */

export function CodeTourEditor({ document: initialDoc, onDocumentChange, onCodeTourHunksChange, onOpenDiff, onCheckoutPR, onRequestChangesOpen, activePR, isEditMode = true, diffLayout = 'inline', scrollToNode, insertHunkCommand, insertMultipleHunksCommand, onProvideGroupsForQuickPick, onActiveNodeChanged, onError, assistantStatus, onRunAssistant, onCancelAssistant, onDismissAssistantError, prState, onRefreshPrState, onUpdateWithClaudeCode, onUpdateWithCopilotChat, changesData, onRemoveExclusion, onOpenExcludedDiff }: CodeTourEditorProps) {
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
			const rect: { top: number; bottom: number } = container
				? container.getBoundingClientRect()
				: { top: 0, bottom: window.innerHeight };
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

	// Partition a list of hunk payloads against the current exclusion list so
	// the insert paths below honor the "tour and excluded list don't overlap"
	// invariant. Returns:
	//   - accepted: payloads safe to insert.
	//   - blocked:  payloads that would conflict with a whole-file / glob
	//     marker; the user is shown a single error explaining why, since
	//     silently dropping a broad marker would un-exclude every other hunk
	//     it covers.
	//   - exactRangeMarkersToDrop: exact-range markers we'll remove from
	//     prev.exclusions because the payloads they used to cover are now
	//     in the tour.
	const partitionAgainstExclusions = useCallback((
		payloads: ReadonlyArray<HunkReference>,
		exclusions: ReadonlyArray<ExcludedHunkMarker>,
	): { accepted: HunkReference[]; blocked: Array<{ payload: HunkReference; markers: ExcludedHunkMarker[] }>; exactRangeMarkersToDrop: ExcludedHunkMarker[] } => {
		const accepted: HunkReference[] = [];
		const blocked: Array<{ payload: HunkReference; markers: ExcludedHunkMarker[] }> = [];
		const exactRangeMarkersToDrop = new Set<ExcludedHunkMarker>();
		for (const p of payloads) {
			const matches = findMarkersMatchingHunk(exclusions, p.file, p.startLine, p.endLine, editContentFingerprint(p.patch));
			const broad = matches.filter(m => !isExactRangeMarker(m));
			if (broad.length > 0) {
				blocked.push({ payload: p, markers: broad });
				continue;
			}
			for (const m of matches) {
				if (isExactRangeMarker(m)) exactRangeMarkersToDrop.add(m);
			}
			accepted.push(p);
		}
		return { accepted, blocked, exactRangeMarkersToDrop: Array.from(exactRangeMarkersToDrop) };
	}, []);

	const reportBlockedInsertions = useCallback((blocked: Array<{ payload: HunkReference; markers: ExcludedHunkMarker[] }>) => {
		if (blocked.length === 0 || !onError) return;
		const sample = blocked.slice(0, 3).map(b => `${b.payload.file}:${b.payload.startLine}-${b.payload.endLine} (covered by file="${b.markers[0].file}")`).join('; ');
		const more = blocked.length > 3 ? `, +${blocked.length - 3} more` : '';
		onError(
			`Skipped ${blocked.length} hunk(s) that are covered by a whole-file / glob exclusion marker (${sample}${more}). ` +
			`Remove the marker from the Excluded outline first if you want to add the hunk to the tour.`,
		);
	}, [onError]);

	// Handle insert hunk command
	useEffect(() => {
		if (!insertHunkCommand) {
			return;
		}

		if (insertHunkCommand.mode === 'active' || insertHunkCommand.mode === 'requestGroupsForQuickPick') {
			applyLocal(prev => {
					const rawPayloads = insertHunkCommand.payload;
					const { accepted: payloads, blocked, exactRangeMarkersToDrop } = partitionAgainstExclusions(rawPayloads, prev.exclusions ?? []);
					reportBlockedInsertions(blocked);
					if (payloads.length === 0) {
						return prev;
					}
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
				const newExclusions = exactRangeMarkersToDrop.length > 0
					? (prev.exclusions ?? []).filter(m => !exactRangeMarkersToDrop.includes(m))
					: prev.exclusions;
				return { ...prev, children: newChildren, exclusions: newExclusions };
			});
		} else if (insertHunkCommand.mode === 'quickpick') {
			if (insertHunkCommand.targetId) {
				applyLocal(prev => {
						const rawPayloads = insertHunkCommand.payload;
						const { accepted: payloads, blocked, exactRangeMarkersToDrop } = partitionAgainstExclusions(rawPayloads, prev.exclusions ?? []);
						reportBlockedInsertions(blocked);
						if (payloads.length === 0) {
							return prev;
						}
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
					const newExclusions = exactRangeMarkersToDrop.length > 0
						? (prev.exclusions ?? []).filter(m => !exactRangeMarkersToDrop.includes(m))
						: prev.exclusions;
					return { ...prev, children: newChildren, exclusions: newExclusions };
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
			const { accepted: payloads, blocked, exactRangeMarkersToDrop } = partitionAgainstExclusions(insertMultipleHunksCommand.payloads, prev.exclusions ?? []);
			reportBlockedInsertions(blocked);
			if (payloads.length === 0) {
				return prev;
			}
			const groupId = localId();
			const newGroup: EditorGroupNode = {
				type: 'group',
				id: groupId,
				title: 'Remaining Changes',
				level: 1, // Will be normalized
				children: payloads.map(payload => ({
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
			const newExclusions = exactRangeMarkersToDrop.length > 0
				? (prev.exclusions ?? []).filter(m => !exactRangeMarkersToDrop.includes(m))
				: prev.exclusions;
			return { ...prev, children: appendToList(prev.children, newGroup), exclusions: newExclusions };
		});
	}, [insertMultipleHunksCommand]);

	const isMismatch = doc.prNumber !== undefined && (
		!activePR ||
		doc.prNumber !== activePR.number ||
		doc.prOwner?.toLowerCase() !== activePR.owner?.toLowerCase() ||
		doc.prRepo?.toLowerCase() !== activePR.repo?.toLowerCase()
	);

	// Outdated-hunk detection. Same machinery as the viewer; the editor adds a
	// pin button (toggles hunk.pinned) and an auto-update path that re-fetches
	// the current patch + baseBlob from `prState`.
	const prStateIndex = useMemo(() => indexPrState(prState), [prState]);

	// Silent line-number refresh for hunks whose content is unchanged but whose
	// position shifted due to unrelated edits elsewhere in the file. Outdated
	// detection treats these as fresh; the stored startLine/endLine/patch are
	// still stale though, which would break line-aware features (open-in-file,
	// jump-to-hunk, etc.). We rewrite them in place via the normal applyLocal
	// pipeline so the saved file stays accurate. The user sees the file dirty
	// after opening the tour - that's the correct signal: the on-disk content
	// did need a (trivial) update.
	useEffect(() => {
		if (!isEditMode) {
			return;
		}
		const updates = findShiftOnlyMatches(doc as unknown as CodeTourDocument, prState, prStateIndex);
		if (updates.length === 0) {
			return;
		}
		const updateMap = new Map(updates.map(u => [u.nodeId, u] as const));
		applyLocal(prev => {
			const refresh = (nodes: EditorNode[]): EditorNode[] => nodes.map(n => {
				if (n.type === 'hunk') {
					const u = updateMap.get(n.id);
					if (u) {
						return {
							...n,
							hunk: {
								...n.hunk,
								startLine: u.newStartLine,
								endLine: u.newEndLine,
								patch: u.newPatch,
								baseBlob: u.newBaseBlob,
							},
						};
					}
				}
				if (n.type === 'group') {
					return { ...n, children: refresh(n.children) };
				}
				return n;
			});
			return { ...prev, children: refresh(prev.children) };
		});
	}, [isEditMode, doc, prState, prStateIndex]);

	const outdatedHunkIds = useMemo(() => computeOutdatedHunks(doc as unknown as CodeTourDocument, prState, prStateIndex), [doc, prState, prStateIndex]);
	const { count: newInPrCount } = useMemo(() => computeNewInPrCount(doc as unknown as CodeTourDocument, prState, prStateIndex), [doc, prState, prStateIndex]);
	const outdatedUnpinnedCount = useMemo(() => {
		let n = 0;
		const walk = (nodes: EditorNode[]) => {
			for (const node of nodes) {
				if (node.type === 'hunk' && outdatedHunkIds.has(node.id) && !node.hunk.pinned) {
					n++;
				} else if (node.type === 'group') {
					walk(node.children);
				}
			}
		};
		walk(doc.children);
		return n;
	}, [doc, outdatedHunkIds]);
	const isTourOutdated = outdatedUnpinnedCount > 0;

	// Toggle a hunk's `pinned` flag in the in-memory editor doc. The standard
	// applyLocal pipeline serializes the change and triggers `onDocumentChange`,
	// which writes through to disk on the next host-side save.
	const handleToggleHunkPinned = useCallback((nodeId: string) => {
		applyLocal(prev => {
			const flip = (nodes: EditorNode[]): EditorNode[] => nodes.map(n => {
				if (n.type === 'hunk' && n.id === nodeId) {
					return { ...n, hunk: { ...n.hunk, pinned: n.hunk.pinned ? undefined : true } };
				}
				if (n.type === 'group') {
					return { ...n, children: flip(n.children) };
				}
				return n;
			});
			return { ...prev, children: flip(prev.children) };
		});
	}, []);

	// Staged auto-updates. Each entry holds the proposed replacement hunk plus
	// the original (in case the user undoes). Pending entries are *not* in the
	// editor's doc tree - the proposed patch is overlaid in the renderer so
	// the file on disk stays untouched until the user clicks Confirm (which
	// applies to the doc and triggers the normal save round-trip) or Undo.
	const [pendingUpdates, setPendingUpdates] = useState<Map<string, { proposed: HunkReference; original: HunkReference }>>(new Map());

	// Node IDs where the per-hunk "Update" button should appear: hunk is
	// outdated, not already pinned, not already staged for update, AND its
	// file is present in the current PR diff (at least one candidate hunk to
	// pull a replacement from). When the file has multiple candidate hunks,
	// the picker UI in HunkBlock lets the author choose which one is the
	// replacement; clicking the button on an ambiguous file opens that picker
	// instead of immediately staging.
	const autoUpdateAvailableNodeIds = useMemo(() => {
		const out = new Set<string>();
		const walk = (nodes: EditorNode[]) => {
			for (const node of nodes) {
				if (node.type === 'hunk' && outdatedHunkIds.has(node.id) && !node.hunk.pinned && !pendingUpdates.has(node.id)) {
					const hunks = prStateIndex.hunksByFile.get(node.hunk.file);
					if (hunks && hunks.length >= 1) {
						out.add(node.id);
					}
				} else if (node.type === 'group') {
					walk(node.children);
				}
			}
		};
		walk(doc.children);
		return out;
	}, [doc, outdatedHunkIds, pendingUpdates, prStateIndex]);

	// "Unambiguous" subset of the above - files with exactly one candidate
	// hunk. Drives the banner-level "Update all" bulk action; ambiguous files
	// are left for the per-hunk picker.
	const autoUpdateUnambiguousNodeIds = useMemo(() => {
		const out = new Set<string>();
		const walk = (nodes: EditorNode[]) => {
			for (const node of nodes) {
				if (node.type === 'hunk' && autoUpdateAvailableNodeIds.has(node.id)) {
					const hunks = prStateIndex.hunksByFile.get(node.hunk.file)!;
					if (hunks.length === 1) {
						out.add(node.id);
					}
				} else if (node.type === 'group') {
					walk(node.children);
				}
			}
		};
		walk(doc.children);
		return out;
	}, [doc, autoUpdateAvailableNodeIds, prStateIndex]);

	// Per-hunk picker visibility: which hunk's "choose which PR hunk to apply"
	// menu is currently open. Cleared on stage / cancel / doc replacement.
	const [pickerOpenFor, setPickerOpenFor] = useState<string | undefined>(undefined);

	// Stage an auto-update for a single hunk.
	// - With `candidateIdx` undefined: open the per-hunk picker so the author
	//   chooses a candidate and decides whether to refresh adjacent narration
	//   with AI. The picker shows even for single-candidate files so the
	//   refresh-narration toggle is always reachable.
	// - With `candidateIdx` set: stage that specific candidate directly. Used
	//   by the picker once the author has chosen.
	// - With `refreshNarration: true`: after staging, dispatch the assistant in
	//   `refreshHunkNarration` mode so the prose around the hunk updates to
	//   match the new patch content. Narration changes apply directly (the LLM
	//   tools mutate the doc); only the patch swap is staged in pendingUpdates.
	const handleStageAutoUpdate = useCallback((nodeId: string, candidateIdx?: number, refreshNarration?: boolean) => {
		const findHunk = (nodes: EditorNode[]): EditorHunkNode | undefined => {
			for (const n of nodes) {
				if (n.type === 'hunk' && n.id === nodeId) return n;
				if (n.type === 'group') {
					const found = findHunk(n.children);
					if (found) return found;
				}
			}
			return undefined;
		};
		const node = findHunk(doc.children);
		if (!node) return;
		const candidates = prStateIndex.hunksByFile.get(node.hunk.file);
		if (!candidates || candidates.length === 0) return;
		if (candidateIdx === undefined) {
			setPickerOpenFor(nodeId);
			return;
		}
		const chosen = candidates[candidateIdx];
		const proposed: HunkReference = {
			...node.hunk,
			startLine: chosen.startLine,
			endLine: chosen.endLine,
			patch: chosen.patch,
			baseBlob: prStateIndex.blobsByFile.get(node.hunk.file) ?? node.hunk.baseBlob,
		};
		setPendingUpdates(prev => {
			const next = new Map(prev);
			next.set(nodeId, { proposed, original: node.hunk });
			return next;
		});
		setPickerOpenFor(undefined);
		if (refreshNarration && onRunAssistant) {
			onRunAssistant('refreshHunkNarration', { hunkId: nodeId });
		}
	}, [doc, prStateIndex, onRunAssistant]);

	const handleCancelAutoUpdatePick = useCallback(() => setPickerOpenFor(undefined), []);

	// Confirm one pending update: replace the doc's hunk with the proposed
	// version and drop the pending entry. The applyLocal pipeline handles
	// the disk save downstream.
	const handleConfirmAutoUpdate = useCallback((nodeId: string) => {
		const entry = pendingUpdates.get(nodeId);
		if (!entry) return;
		applyLocal(prev => {
			const replace = (nodes: EditorNode[]): EditorNode[] => nodes.map(n => {
				if (n.type === 'hunk' && n.id === nodeId) {
					return { ...n, hunk: entry.proposed };
				}
				if (n.type === 'group') {
					return { ...n, children: replace(n.children) };
				}
				return n;
			});
			return { ...prev, children: replace(prev.children) };
		});
		setPendingUpdates(prev => {
			const next = new Map(prev);
			next.delete(nodeId);
			return next;
		});
	}, [pendingUpdates]);

	// Discard one pending update: drop the entry without touching the doc.
	const handleDiscardAutoUpdate = useCallback((nodeId: string) => {
		setPendingUpdates(prev => {
			const next = new Map(prev);
			next.delete(nodeId);
			return next;
		});
	}, []);

	// Confirm every pending update in one applyLocal pass + one save.
	const handleConfirmAllUpdates = useCallback(() => {
		if (pendingUpdates.size === 0) return;
		applyLocal(prev => {
			const replace = (nodes: EditorNode[]): EditorNode[] => nodes.map(n => {
				if (n.type === 'hunk') {
					const entry = pendingUpdates.get(n.id);
					if (entry) {
						return { ...n, hunk: entry.proposed };
					}
				}
				if (n.type === 'group') {
					return { ...n, children: replace(n.children) };
				}
				return n;
			});
			return { ...prev, children: replace(prev.children) };
		});
		setPendingUpdates(new Map());
	}, [pendingUpdates]);

	const handleDiscardAllUpdates = useCallback(() => setPendingUpdates(new Map()), []);

	// Bulk stage every unambiguously updatable hunk in one shot. Skips hunks
	// that are pinned, already pending, or whose file has multiple current PR
	// hunks (ambiguous).
	// Stage every unambiguous auto-update in one shot. `refreshNarration`
	// (when true) also dispatches the assistant in `refreshHunkNarration` mode
	// for each newly-staged hunk so the surrounding prose updates to match.
	// Returns the list of hunk IDs that were just staged so callers can chain
	// further AI work (e.g. agentic Update with AI).
	const handleUpdateAllUnambiguous = useCallback((opts?: { refreshNarration?: boolean }): string[] => {
		if (autoUpdateUnambiguousNodeIds.size === 0) return [];
		const next = new Map(pendingUpdates);
		const newlyStaged: string[] = [];
		const walk = (nodes: EditorNode[]) => {
			for (const node of nodes) {
				if (node.type === 'hunk' && autoUpdateUnambiguousNodeIds.has(node.id)) {
					const hunks = prStateIndex.hunksByFile.get(node.hunk.file)!;
					next.set(node.id, {
						proposed: {
							...node.hunk,
							startLine: hunks[0].startLine,
							endLine: hunks[0].endLine,
							patch: hunks[0].patch,
							baseBlob: prStateIndex.blobsByFile.get(node.hunk.file) ?? node.hunk.baseBlob,
						},
						original: node.hunk,
					});
					newlyStaged.push(node.id);
				} else if (node.type === 'group') {
					walk(node.children);
				}
			}
		};
		walk(doc.children);
		setPendingUpdates(next);
		if (opts?.refreshNarration && onRunAssistant) {
			for (const id of newlyStaged) {
				onRunAssistant('refreshHunkNarration', { hunkId: id });
			}
		}
		return newlyStaged;
	}, [autoUpdateUnambiguousNodeIds, doc, pendingUpdates, prStateIndex, onRunAssistant]);

	// Top-level "Update with AI" entry point. Stages every unambiguous update
	// (the user then sees the same Pending pills they would after a manual
	// per-hunk pick) and *also* runs the agentic `updateTour` assistant for
	// the ambiguous cases + narration. The two phases work together: the
	// staged pending pills are visible while the LLM works on the rest, so
	// the user can review and confirm the patch swaps even before the AI
	// finishes its narration pass.
	const handleUpdateWithAI = useCallback(() => {
		if (!onRunAssistant) return;
		handleUpdateAllUnambiguous({ refreshNarration: true });
		onRunAssistant('updateTour');
	}, [handleUpdateAllUnambiguous, onRunAssistant]);

	// AI review session: when the assistant runs (any mode), snapshot the
	// pre-AI doc and surface the diff so the user can see *what* the AI added
	// and revert if unhappy. Patch swaps the user staged manually keep going
	// through pendingUpdates; this catches the other LLM mutations (text node
	// additions, hunk insertions for ambiguous files, removals, etc).
	const [aiSessionSnapshot, setAiSessionSnapshot] = useState<EditorDocument | undefined>(undefined);
	const previousAssistantRunningRef = useRef(false);
	useEffect(() => {
		const isRunning = !!assistantStatus?.running;
		if (isRunning && !previousAssistantRunningRef.current) {
			// Transition: idle → running. Snapshot the doc as it is right now.
			// If the user has staged pending updates, those are NOT in the
			// snapshot (the doc's hunks still show original patches); confirming
			// them later goes through the usual applyLocal pipeline. The AI's
			// own mutations (text, new hunks, etc.) are what we're tracking.
			setAiSessionSnapshot(prev => prev ?? cloneDoc(doc as unknown as CodeTourDocument));
		}
		previousAssistantRunningRef.current = isRunning;
	}, [assistantStatus?.running, doc]);

	// Live diff of pre-AI snapshot vs current doc → IDs of newly-introduced
	// nodes. Recomputes on every doc edit while the session is open, so the
	// user sees nodes light up the moment the assistant calls a write tool.
	const aiAddedNodeIds = useMemo(() => {
		if (!aiSessionSnapshot) {
			return new Set<string>();
		}
		const before = collectFingerprints(aiSessionSnapshot.children);
		const added = new Set<string>();
		const walk = (nodes: EditorNode[], parentPath: string) => {
			for (const n of nodes) {
				if (n.type !== 'dropzone') {
					const fp = nodeFingerprint(n, parentPath);
					if (!before.has(fp)) {
						added.add(n.id);
					}
				}
				if (n.type === 'group') {
					walk(n.children, `${parentPath}/${n.title}`);
				}
			}
		};
		walk(doc.children, '');
		return added;
	}, [aiSessionSnapshot, doc]);

	const handleAcceptAiChanges = useCallback(() => {
		setAiSessionSnapshot(undefined);
	}, []);

	const handleRevertAiChanges = useCallback(() => {
		if (!aiSessionSnapshot) return;
		applyLocal(() => cloneDoc(aiSessionSnapshot as unknown as CodeTourDocument));
		setAiSessionSnapshot(undefined);
		setPendingUpdates(new Map());
		setPickerOpenFor(undefined);
	}, [aiSessionSnapshot]);

	// Narration group of the currently-active node (the selected paragraph
	// + its contiguous run of following hunks). Activating any member keeps
	// the same group lit, so clicking a hunk after clicking its intro
	// paragraph doesn't flicker the accent away. See `findNarrationGroup`.
	const narrationGroup = useMemo<NarrationGroup>(() => {
		if (!activeNodeId) return { members: new Set(), lastId: undefined };
		return findNarrationGroup(doc.children, activeNodeId);
	}, [doc, activeNodeId]);

	const aiAddedNodeIdsInDocOrder = useMemo(() => {
		if (aiAddedNodeIds.size === 0) return [] as string[];
		const ids: string[] = [];
		const walk = (nodes: EditorNode[]) => {
			for (const n of nodes) {
				if (aiAddedNodeIds.has(n.id)) ids.push(n.id);
				if (n.type === 'group') walk(n.children);
			}
		};
		walk(doc.children);
		return ids;
	}, [aiAddedNodeIds, doc]);

	// Counter for the "Next (k/N)" button label. State (not a ref) so the
	// label re-renders when the user advances; reset whenever the session
	// flips (start / accept / revert).
	const [aiNavIdx, setAiNavIdx] = useState(0);
	useEffect(() => {
		setAiNavIdx(0);
	}, [aiSessionSnapshot]);
	const handleShowNextAiChange = useCallback(() => {
		if (aiAddedNodeIdsInDocOrder.length === 0) return;
		const target = aiAddedNodeIdsInDocOrder[aiNavIdx % aiAddedNodeIdsInDocOrder.length];
		setAiNavIdx(prev => (prev + 1) % aiAddedNodeIdsInDocOrder.length);
		const el = document.getElementById(`node-${target}`);
		if (el) {
			el.scrollIntoView({ behavior: 'smooth', block: 'center' });
			el.classList.add('tour-node-flash');
			setTimeout(() => el.classList.remove('tour-node-flash'), 1500);
		}
	}, [aiAddedNodeIdsInDocOrder, aiNavIdx]);

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
		// Pending auto-updates and any open picker are in-memory drafts against
		// the editor's local doc state. When the host pushes a fresh doc
		// (undo/redo, external edit), the drafts no longer make sense against
		// the new tree - drop them to keep the proposed-vs-original anchor
		// consistent.
		setPendingUpdates(new Map());
		setPickerOpenFor(undefined);
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

	// Edit an exclusion marker's reason in place. Matches the marker by its
	// (file, startLine, endLine) identity; an empty reason clears the
	// attribute. Deferred like the summary editor so each keystroke persists
	// without forcing an immediate document flush.
	const handleExclusionReasonChange = useCallback(
		(file: string, startLine: number | undefined, endLine: number | undefined, reason: string) => {
			applyLocal(prev => ({
				...prev,
				exclusions: (prev.exclusions ?? []).map(e =>
					e.file === file && e.startLine === startLine && e.endLine === endLine
						? { ...e, reason: reason.trim().length > 0 ? reason : undefined }
						: e,
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
			const { accepted, blocked, exactRangeMarkersToDrop } = partitionAgainstExclusions([payload], prev.exclusions ?? []);
			reportBlockedInsertions(blocked);
			if (accepted.length === 0) {
				return prev;
			}
			const updated: EditorDocument = {
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
			if (updated.prNumber === undefined && payload.prNumber !== undefined) {
				updated.prNumber = payload.prNumber;
				updated.prOwner = payload.prOwner;
				updated.prRepo = payload.prRepo;
				updated.baseSha = payload.baseSha;
				updated.headSha = payload.headSha;
				if (updated.schemaVersion === undefined) {
					updated.schemaVersion = 1;
				}
			}

			if (exactRangeMarkersToDrop.length > 0) {
				updated.exclusions = (prev.exclusions ?? []).filter(m => !exactRangeMarkersToDrop.includes(m));
			}
			return updated;
		});
	}, [applyLocal, partitionAgainstExclusions, reportBlockedInsertions]);

	// Validate that a dropped hunk payload comes from the same PR the tour is
	// bound to. Returns true on success, surfaces an error on mismatch.
	const validateHunkPayloadPR = useCallback((payload: HunkPayload): boolean => {
		if (doc.prNumber === undefined) {
			return true;
		}
		const prNumberMatches = !doc.prNumber || !payload.prNumber || String(doc.prNumber) === String(payload.prNumber);
		const prOwnerMatches = !doc.prOwner || !payload.prOwner || doc.prOwner === payload.prOwner;
		const prRepoMatches = !doc.prRepo || !payload.prRepo || doc.prRepo === payload.prRepo;
		if (!prNumberMatches || !prOwnerMatches || !prRepoMatches) {
			const msg = `Cannot drop a hunk from a different pull request. Expected pull request #${doc.prNumber} (${doc.prOwner}/${doc.prRepo}), but got pull request #${payload.prNumber} (${payload.prOwner}/${payload.prRepo})`;
			if (onError) {
				onError(msg);
			} else {
				window.alert(msg);
			}
			return false;
		}
		return true;
	}, [doc.prNumber, doc.prOwner, doc.prRepo, onError]);

	// Insert a dropped hunk payload immediately before/after a specific node,
	// matching the fine-grained drop indicator the reorder UI already uses.
	// The caller (NodeShell) handles the drop-position display; we just
	// apply the insertion at the requested spot.
	const handleHunkDropAtNode = useCallback((payload: HunkPayload, targetId: string, position: DropPosition) => {
		if (!validateHunkPayloadPR(payload)) {
			return;
		}
		applyLocal(prev => {
			const { accepted, blocked, exactRangeMarkersToDrop } = partitionAgainstExclusions([payload], prev.exclusions ?? []);
			reportBlockedInsertions(blocked);
			if (accepted.length === 0) {
				return prev;
			}
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
			if (updated.prNumber === undefined && payload.prNumber !== undefined) {
				updated.prNumber = payload.prNumber;
				updated.prOwner = payload.prOwner;
				updated.prRepo = payload.prRepo;
				updated.baseSha = payload.baseSha;
				updated.headSha = payload.headSha;
				if (updated.schemaVersion === undefined) {
					updated.schemaVersion = 1;
				}
			}
			if (exactRangeMarkersToDrop.length > 0) {
				updated.exclusions = (prev.exclusions ?? []).filter(m => !exactRangeMarkersToDrop.includes(m));
			}
			setJustInsertedId(newId);
			return updated;
		});
	}, [applyLocal, validateHunkPayloadPR, partitionAgainstExclusions, reportBlockedInsertions]);

	// Append a hunk payload as a new hunk node at the end of the tour root.
	// Used when the user drags from the diff picker without first creating a
	// dropzone - they shouldn't have to set up a landing zone first.
	const handleAppendHunkPayload = useCallback((payload: HunkPayload) => {
		applyLocal(prev => {
			const { accepted, blocked, exactRangeMarkersToDrop } = partitionAgainstExclusions([payload], prev.exclusions ?? []);
			reportBlockedInsertions(blocked);
			if (accepted.length === 0) {
				return prev;
			}
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
				exclusions: exactRangeMarkersToDrop.length > 0
					? (prev.exclusions ?? []).filter(m => !exactRangeMarkersToDrop.includes(m))
					: prev.exclusions,
			};
			if (updated.prNumber === undefined && payload.prNumber !== undefined) {
				updated.prNumber = payload.prNumber;
				updated.prOwner = payload.prOwner;
				updated.prRepo = payload.prRepo;
				updated.baseSha = payload.baseSha;
				updated.headSha = payload.headSha;
				if (updated.schemaVersion === undefined) {
					updated.schemaVersion = 1;
				}
			}
			setJustInsertedId(newId);
			return updated;
		});
	}, [applyLocal, partitionAgainstExclusions, reportBlockedInsertions]);

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
			{(assistantStatus?.running || aiSessionSnapshot) && (
				<div className="tour-assistant-sticky-stack">
					{assistantStatus?.running && (
						<div className="tour-assistant-streaming" role="status" aria-live="polite">
							<span className="tour-assistant-streaming-icon">{sparkleIcon}</span>
							<span className="tour-assistant-streaming-label">{assistantStatus.label ?? 'Working…'}</span>
							{onCancelAssistant && (
								<Tooltip text="Stop the AI assistant">
									<button
										type="button"
										className="tour-action-btn icon-button tour-assistant-stop-button"
										onClick={onCancelAssistant}
									>
										{stopCircleIcon}
									</button>
								</Tooltip>
							)}
						</div>
					)}
					{aiSessionSnapshot && (
						<div className="tour-pr-warning tour-ai-review-banner">
							<span>
								{assistantStatus?.running
									? (aiAddedNodeIds.size === 0
										? 'AI is updating the tour…'
										: <>AI is updating the tour - <strong>{aiAddedNodeIds.size} new node{aiAddedNodeIds.size === 1 ? '' : 's'}</strong> so far. They are highlighted below.</>)
									: (aiAddedNodeIds.size === 0
										? 'AI finished without adding new nodes. Review and Accept or Revert.'
										: <>AI made changes - <strong>{aiAddedNodeIds.size} new node{aiAddedNodeIds.size === 1 ? '' : 's'}</strong> highlighted below.</>)
								}
							</span>
							<div className="tour-pr-warning-actions">
								{aiAddedNodeIds.size > 0 && (
									<Tooltip text="Scroll to the next AI-added node">
										<button
											className="tour-action-btn"
											onClick={handleShowNextAiChange}
										>
											Next ({(aiNavIdx % Math.max(1, aiAddedNodeIdsInDocOrder.length)) + 1}/{aiAddedNodeIdsInDocOrder.length})
										</button>
									</Tooltip>
								)}
								<Tooltip text="Keep all AI changes; dismiss the highlight and review banner.">
									<button
										className="tour-action-btn"
										onClick={handleAcceptAiChanges}
										disabled={!!assistantStatus?.running}
									>
										Accept
									</button>
								</Tooltip>
								<Tooltip text="Roll the doc back to the state it was in before the AI started. Any pending patch updates are dropped too.">
									<button
										className="tour-action-btn"
										onClick={handleRevertAiChanges}
										disabled={!!assistantStatus?.running}
									>
										Revert all
									</button>
								</Tooltip>
							</div>
						</div>
					)}
				</div>
			)}
			{assistantStatus?.error && !assistantStatus.running && (
				<div className="tour-assistant-error" role="alert">
					<span>⚠️ {assistantStatus.error}</span>
					{onDismissAssistantError && (
						<Tooltip text="Dismiss">
							<button
								type="button"
								className="tour-action-btn icon-button"
								onClick={onDismissAssistantError}
							>
								×
							</button>
						</Tooltip>
					)}
				</div>
			)}
			{isMismatch && (
				<div className="tour-pr-warning">
					<span>This Change Tour belongs to PR #{doc.prNumber}. "Open in file context" is unavailable until the PR is checked out.</span>
					{onCheckoutPR && (
						<button className="tour-action-btn" onClick={onCheckoutPR}>
							Checkout PR
						</button>
					)}
				</div>
			)}
			{(isTourOutdated || newInPrCount > 0 || pendingUpdates.size > 0) && (
				<div className="tour-pr-warning tour-outdated-warning">
					<span>
						{isTourOutdated && (
							<>This Change Tour is outdated. <strong>{outdatedUnpinnedCount} hunk{outdatedUnpinnedCount === 1 ? '' : 's'}</strong> drifted from the pull request.{(newInPrCount > 0 || pendingUpdates.size > 0) ? ' ' : ''}</>
						)}
						{newInPrCount > 0 && (
							<>The PR has <strong>{newInPrCount} hunk{newInPrCount === 1 ? '' : 's'}</strong> not covered by this tour.{pendingUpdates.size > 0 ? ' ' : ''}</>
						)}
						{pendingUpdates.size > 0 && (
							<><strong>{pendingUpdates.size} pending update{pendingUpdates.size === 1 ? '' : 's'}</strong> ready to confirm.</>
						)}
					</span>
					<div className="tour-pr-warning-actions">
						{pendingUpdates.size > 0 && (
							<>
								<Tooltip text="Apply all staged updates and save the file">
									<button className="tour-action-btn" onClick={handleConfirmAllUpdates}>
										Confirm all
									</button>
								</Tooltip>
								<Tooltip text="Drop all staged updates (the doc is not modified)">
									<button className="tour-action-btn" onClick={handleDiscardAllUpdates}>
										Discard all
									</button>
								</Tooltip>
							</>
						)}
						{autoUpdateUnambiguousNodeIds.size > 0 && (
							<Tooltip text="Stage proposed updates for every drifted hunk whose file has exactly one current PR hunk. Files with multiple hunks need the per-hunk picker. Narration is not refreshed - use Update with AI for that.">
								<button className="tour-action-btn" onClick={() => handleUpdateAllUnambiguous()}>
									Update {autoUpdateUnambiguousNodeIds.size === outdatedUnpinnedCount ? 'all' : autoUpdateUnambiguousNodeIds.size}
								</button>
							</Tooltip>
						)}
						{isTourOutdated && onRunAssistant && (
							<Tooltip text="Update with AI - stage every unambiguous patch swap (review them in the Pending pills) and run the assistant to refresh narration and handle ambiguous hunks. Patch swaps stay pending until you click the check button; narration applies directly.">
								<button
									className="tour-banner-assistant-button"
									disabled={!!assistantStatus?.running}
									onClick={handleUpdateWithAI}
									aria-label="Update with AI"
								>
									{sparkleIcon}
								</button>
							</Tooltip>
						)}
						{isTourOutdated && onUpdateWithClaudeCode && (
							<Tooltip text="Update with Claude CLI - open a terminal seeded with an update-this-tour prompt. The change-tour skill is installed at .claude/skills/change-tour/ if it isn't already.">
								<button
									className="tour-banner-assistant-button"
									onClick={onUpdateWithClaudeCode}
									aria-label="Update with Claude CLI"
								>
									{terminalIcon}
								</button>
							</Tooltip>
						)}
						{isTourOutdated && onUpdateWithCopilotChat && (
							<Tooltip text="Update with @change-tour - open Copilot Chat with `@change-tour /update` pre-loaded so you can review and submit the update request.">
								<button
									className="tour-banner-assistant-button"
									onClick={onUpdateWithCopilotChat}
									aria-label="Update with Copilot Chat"
								>
									{copilotIcon}
								</button>
							</Tooltip>
						)}
						{onRefreshPrState && (
							<Tooltip text="Re-fetch the PR's current state">
								<button className="tour-action-btn" onClick={onRefreshPrState}>
									Refresh
								</button>
							</Tooltip>
						)}
					</div>
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
								dragState={dragState}
								dropTargetId={node.id}
								onReorder={handleReorder}
								onHunkDropAtNode={handleHunkDropAtNode}
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
							outdatedHunkIds={outdatedHunkIds}
							onTogglePinned={handleToggleHunkPinned}
							pendingUpdates={pendingUpdates}
							autoUpdateAvailableNodeIds={autoUpdateAvailableNodeIds}
							onStageAutoUpdate={handleStageAutoUpdate}
							onConfirmAutoUpdate={handleConfirmAutoUpdate}
							onDiscardAutoUpdate={handleDiscardAutoUpdate}
							prStateIndex={prStateIndex}
							pickerOpenFor={pickerOpenFor}
							onCancelAutoUpdatePick={handleCancelAutoUpdatePick}
							aiAddedNodeIds={aiAddedNodeIds}
							narrationGroup={narrationGroup}
						/>
					</React.Fragment>
				))}
				{isEditMode && (
					<div className="tour-root-actions">
						<Tooltip text="Add text">
							<button className="tour-add-btn icon-button" onClick={() => handleAddText()}>{symbolStringIcon}</button>
						</Tooltip>
						<Tooltip text="Add hunk">
							<button className="tour-add-btn icon-button" onClick={() => handleAddCode()}>{codeIcon}</button>
						</Tooltip>
						<Tooltip text="Add section">
							<button className="tour-add-btn icon-button" onClick={() => handleAddGroup()}>{newCollectionIcon}</button>
						</Tooltip>
						{onRunAssistant && (
							<Tooltip text={
								!doc.prNumber
									? 'Bind the tour to a pull request (via "Pull Request: New Change Tour") to enable AI generation'
									: 'Auto-generate the full Change Tour with AI'
							}>
								<button
									className="tour-add-btn icon-button tour-assistant-button"
									disabled={!doc.prNumber || !!assistantStatus?.running}
									onClick={() => onRunAssistant('autoGenerate')}
								>
									{sparkleIcon}
								</button>
							</Tooltip>
						)}
					</div>
				)}
				{(doc.exclusions?.length ?? 0) > 0 && (
					<ExcludedOutlineSection
						exclusions={doc.exclusions ?? []}
						changesData={changesData}
						isEditMode={isEditMode}
						onOpenExcludedDiff={onOpenExcludedDiff}
						onRemoveExclusion={onRemoveExclusion}
						onReasonChange={handleExclusionReasonChange}
					/>
				)}
			</div>
		</div>
	);
}

/**
 * Outline section rendered at the tail of the editor's left pane, listing
 * every `<!-- changetour:exclude ... -->` marker in the tour. In edit mode
 * each row exposes:
 *   - **Open diff** -> resolves the marker against `changesData` and fires
 *     `onOpenDiff` with a synthesized `HunkReference`. For exact-range
 *     markers there's one matching hunk; for whole-file or glob markers we
 *     open the first matching hunk (the section is still useful as a
 *     navigation jump, even when there are multiple).
 *   - **x remove** -> fires `onRemoveExclusion` so the provider drops the
 *     matching `<!-- changetour:exclude ... -->` line from the markdown.
 *
 * In view mode the rows are read-only (no buttons), matching how the
 * synthetic Excluded outline in the viewer behaves.
 */
/**
 * Single-line reason field for an exclusion marker. In edit mode it shows the
 * reason as plain (truncated) text at rest, and reveals an editable input box
 * only when the row is hovered or the input is focused (CSS-driven, keyed off
 * `.excluded-outline-item:hover` / `:focus-within`) - so the edit affordance
 * isn't always present. Mirrors the hunk summary editor: a local draft holds
 * the in-progress value so the field doesn't snap back while typing, and each
 * keystroke persists via `onChange`. In read-only mode it just renders the
 * (truncated) reason text, or nothing when there's no reason.
 */
function ExcludedReasonField({
	reason,
	editable,
	onChange,
}: {
	reason?: string;
	editable: boolean;
	onChange?: (value: string) => void;
}) {
	const [draft, setDraft] = useState<string | null>(null);

	if (!editable) {
		return reason
			? <span className="excluded-outline-reason" title={reason}>{reason}</span>
			: null;
	}

	const value = draft !== null ? draft : (reason ?? '');
	return (
		<span className="excluded-outline-reason-edit">
			<span className="excluded-outline-reason-display" title={reason}>
				{reason
					? reason
					: <span className="excluded-outline-reason-empty">Add a reason…</span>}
			</span>
			<input
				type="text"
				className="excluded-outline-reason-input"
				value={value}
				placeholder="Add a reason…"
				title={reason || 'Reason this change is excluded from the tour'}
				onFocus={() => setDraft(reason ?? '')}
				onChange={e => { setDraft(e.target.value); onChange?.(e.target.value); }}
				onBlur={() => setDraft(null)}
				onClick={e => e.stopPropagation()}
			/>
		</span>
	);
}

function ExcludedOutlineSection({
	exclusions,
	changesData,
	isEditMode,
	onOpenExcludedDiff,
	onRemoveExclusion,
	onReasonChange,
}: {
	exclusions: ReadonlyArray<ExcludedHunkMarker>;
	changesData: ChangeTourChangesData | undefined;
	isEditMode: boolean;
	onOpenExcludedDiff?: (hunks: HunkReference[], target: string) => void;
	onRemoveExclusion?: (file: string, startLine?: number, endLine?: number) => void;
	onReasonChange?: (file: string, startLine: number | undefined, endLine: number | undefined, reason: string) => void;
}) {
	// Resolve every PR hunk that this marker covers (not just the first), so
	// the Open-diff button can surface a quickpick when a glob or whole-file
	// marker matches multiple hunks.
	const resolveAllHunks = (e: ExcludedHunkMarker): HunkReference[] => {
		const files: Array<{ fileName: string; previousFileName?: string; patch?: string; blobSha?: string }> = changesData?.files ?? [];
		const matchedFiles = isGlob(e.file) ? files.filter(f => matchesGlob(e.file, f.fileName)) : files.filter(f => f.fileName === e.file);
		const out: HunkReference[] = [];
		for (const f of matchedFiles) {
			if (!f.patch) continue;
			const lines = f.patch.split('\n');
			let cur: { startLine: number; endLine: number; buf: string[] } | undefined;
			const all: Array<{ startLine: number; endLine: number; patch: string }> = [];
			const flush = () => { if (cur) all.push({ startLine: cur.startLine, endLine: cur.endLine, patch: cur.buf.join('\n') }); cur = undefined; };
			for (const line of lines) {
				const m = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line);
				if (m) {
					flush();
					const start = parseInt(m[1], 10);
					const len = m[2] !== undefined ? parseInt(m[2], 10) : 1;
					cur = { startLine: start, endLine: start + Math.max(len, 1) - 1, buf: [line] };
					continue;
				}
				if (cur) cur.buf.push(line);
			}
			flush();
			const targets = (e.startLine !== undefined && e.endLine !== undefined)
				? all.filter(h => h.startLine === e.startLine && h.endLine === e.endLine)
				: all;
			for (const t of targets) {
				out.push({
					file: f.fileName,
					startLine: t.startLine,
					endLine: t.endLine,
					patch: t.patch,
					previousFile: f.previousFileName,
					baseBlob: f.blobSha,
					summary: e.reason,
				});
			}
		}
		return out;
	};

	const markerTarget = (e: ExcludedHunkMarker): string => {
		if (e.startLine !== undefined && e.endLine !== undefined) return `${e.file}:${e.startLine}-${e.endLine}`;
		return e.file;
	};

	const renderTarget = (e: ExcludedHunkMarker) => {
		const hasRange = e.startLine !== undefined && e.endLine !== undefined;
		return (
			<>
				<span className="excluded-outline-file">{e.file}</span>
				{hasRange
					? <span className="excluded-outline-range">{`:${e.startLine}-${e.endLine}`}</span>
					: <span className="excluded-outline-kind"> {isGlob(e.file) ? '(pattern)' : '(whole file)'}</span>}
			</>
		);
	};

	return (
		<div className="excluded-outline">
			<div className="excluded-outline-header">
				<span className="excluded-outline-header-icon">{eyeClosedIcon}</span>
				<span className="excluded-outline-header-title">Excluded</span>
				<span className="excluded-outline-header-count">({exclusions.length})</span>
			</div>
			<ul className="excluded-outline-list">
				{exclusions.map((e, i) => {
					const matchingHunks = resolveAllHunks(e);
					const canOpen = matchingHunks.length > 0 && !!onOpenExcludedDiff;
					const target = markerTarget(e);
					const openTooltip = canOpen
						? (matchingHunks.length === 1
							? 'Open in file context'
							: `Pick which of ${matchingHunks.length} matching hunks to open in file context`)
						: (changesData ? 'No matching PR hunks found for this marker.' : 'PR file changes are still loading…');
					return (
						<li key={`${e.file}:${e.startLine ?? '*'}-${e.endLine ?? '*'}:${i}`} className="excluded-outline-item">
							<span className="excluded-outline-target">{renderTarget(e)}</span>
							<ExcludedReasonField
								reason={e.reason}
								editable={isEditMode}
								onChange={onReasonChange ? value => onReasonChange(e.file, e.startLine, e.endLine, value) : undefined}
							/>
							{isEditMode && (
								<span className="excluded-outline-actions">
									<Tooltip text={openTooltip}>
										<button
											type="button"
											className="icon-button excluded-outline-action-btn"
											disabled={!canOpen}
											onClick={() => { if (canOpen && onOpenExcludedDiff) onOpenExcludedDiff(matchingHunks, target); }}
										>
											{diffSingleIcon}
										</button>
									</Tooltip>
									{onRemoveExclusion && (
										<Tooltip text="Remove this exclusion marker">
											<button
												type="button"
												className="icon-button excluded-outline-action-btn"
												onClick={() => onRemoveExclusion(e.file, e.startLine, e.endLine)}
											>
												{trashIcon}
											</button>
										</Tooltip>
									)}
								</span>
							)}
						</li>
					);
				})}
			</ul>
		</div>
	);
}
