/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { InlineCommentComposer } from './inlineCommentComposer';
import { InlineCommentThread } from './inlineCommentThread';
import { aggregateHunkSummary, type FileHunkGroup, hunkKeyFor } from './viewerModel';
import { DiffSide, type IReviewThread } from '../../src/common/comment';
import type { HighlightRange, HunkReference, TourHunkNode } from '../../src/github/codeTourMarkdown';
import { indicesFromHighlights } from '../common/diffHighlights';
import { DiffTable } from '../common/DiffTable';
import { ParsedDiffLine, parsePatch } from '../common/diffUtils';
import { Tooltip } from '../common/tooltip';
import { chevronDownIcon, diffSingleIcon } from '../components/icon';

export interface CommentTarget {
	line: number;
	side: 'LEFT' | 'RIGHT';
}

interface ViewerRightPaneProps {
	diffLayout: 'inline' | 'sideBySide';
	headSha?: string;
	/** Set of TourHunkNode IDs whose underlying file has drifted from `baseBlob`. Drives the per-hunk "Outdated" / "History (Pinned)" badge. */
	outdatedHunkIds?: Set<string>;
	fileGroups: FileHunkGroup[];
	totalsByFile: Map<string, number>;
	threadsByHunkId: Map<string, IReviewThread[]>;
	/**
	 * Per-card "active" duplicate set, keyed by hunkKey. The card renders summary +
	 * highlights aggregated over these nodes (rather than all duplicates) so
	 * paragraph selection switches which occurrence's authored content is shown.
	 * When no paragraph is selected this just contains every duplicate. When a
	 * paragraph is selected, cards adjacent to it are filtered to only their
	 * adjacent occurrences; cards not adjacent fall back to all their duplicates.
	 */
	activeNodesByKey: Map<string, TourHunkNode[]>;
	/** Hunk keys for cards whose active set was narrowed by paragraph selection. Drives the "this card matches the selected paragraph" visual + highlights gate. */
	associatedHunkKeys: Set<string>;
	scrollTargetHunkId: string | undefined;
	showHighlights: boolean;
	onToggleHighlights: () => void;
	onOpenDiff: (hunk: HunkReference) => void;
	onPostLineComment: (hunk: HunkReference, target: CommentTarget, body: string) => Promise<void>;
	onReplyToThread: (thread: IReviewThread, body: string) => Promise<void>;
	commentsEnabled: boolean;
	commentsDisabledReason?: string;
	openDiffDisabled: boolean;
	openDiffDisabledReason?: string;
	isFiltering: boolean;
	filterLabel?: string;
	shownHunkCount: number;
	totalHunkCount: number;
	shownFileCount: number;
	totalFileCount: number;
	/** Hide the "X of Y hunks · A of B files" subtitle in the filter banner. Used by filters where the denominator isn't meaningful (e.g. "Uncovered" - the count is hunks NOT in the tour, so dividing by the tour's hunk total is misleading). */
	filterHideCounts?: boolean;
	/** Override label for the filter banner's clear button. Defaults to "Show all". */
	filterClearLabel?: string;
	onClearFilter: () => void;
	emptyMessage?: string;
	viewedHunks: Set<string>;
	collapsedHunks: Set<string>;
	collapsedFiles: Set<string>;
	onToggleHunkViewed: (key: string) => void;
	onToggleHunkCollapsed: (key: string) => void;
	onToggleFileCollapsed: (file: string) => void;
}

export function ViewerRightPane({
	diffLayout,
	headSha,
	outdatedHunkIds,
	fileGroups,
	totalsByFile,
	threadsByHunkId,
	activeNodesByKey,
	associatedHunkKeys,
	scrollTargetHunkId,
	showHighlights,
	onToggleHighlights,
	onOpenDiff,
	onPostLineComment,
	onReplyToThread,
	commentsEnabled,
	commentsDisabledReason,
	openDiffDisabled,
	openDiffDisabledReason,
	isFiltering,
	filterLabel,
	shownHunkCount,
	totalHunkCount,
	shownFileCount,
	totalFileCount,
	filterHideCounts,
	filterClearLabel,
	onClearFilter,
	emptyMessage,
	viewedHunks,
	collapsedHunks,
	collapsedFiles,
	onToggleHunkViewed,
	onToggleHunkCollapsed,
	onToggleFileCollapsed,
}: ViewerRightPaneProps) {
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!scrollTargetHunkId) {
			return;
		}
		const el = containerRef.current?.querySelector(`#viewer-hunk-${cssEscape(scrollTargetHunkId)}`);
		if (el) {
			(el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'nearest' });
		}
	}, [scrollTargetHunkId]);

	const isEmpty = fileGroups.length === 0;

	return (
		<div className="viewer-right" ref={containerRef}>
			{isFiltering && (
				<FilterStatusBar
					label={filterLabel}
					shownHunkCount={shownHunkCount}
					totalHunkCount={totalHunkCount}
					shownFileCount={shownFileCount}
					totalFileCount={totalFileCount}
					hideCounts={filterHideCounts}
					clearLabel={filterClearLabel}
					onClearFilter={onClearFilter}
				/>
			)}
			<div className="viewer-right-toolbar">
				<label className="viewer-toolbar-toggle">
					<span className="checkbox-wrapper">
						<input
							type="checkbox"
							checked={showHighlights}
							onChange={onToggleHighlights}
						/>
					</span>
					<span>Show Change Tour highlights</span>
				</label>
				{!commentsEnabled && commentsDisabledReason && (
					<div className="viewer-right-hint">{commentsDisabledReason}</div>
				)}
			</div>
			{isEmpty ? (
				<div className="viewer-right-empty">{emptyMessage ?? 'No hunks to show.'}</div>
			) : (
				fileGroups.map(group => (
					<FileGroupBlock
						key={group.file}
						diffLayout={diffLayout}
						headSha={headSha}
						outdatedHunkIds={outdatedHunkIds}
						file={group.file}
						hunks={group.hunks}
						activeNodesByKey={activeNodesByKey}
						totalHunksForFile={totalsByFile.get(group.file) ?? group.hunks.length}
						threadsByHunkId={threadsByHunkId}
						associatedHunkKeys={associatedHunkKeys}
						showHighlights={showHighlights}
						onOpenDiff={onOpenDiff}
						onPostLineComment={onPostLineComment}
						onReplyToThread={onReplyToThread}
						commentsEnabled={commentsEnabled}
						commentsDisabledReason={commentsDisabledReason}
						openDiffDisabled={openDiffDisabled}
						openDiffDisabledReason={openDiffDisabledReason}
						viewedHunks={viewedHunks}
						collapsedHunks={collapsedHunks}
						isFileCollapsed={collapsedFiles.has(group.file)}
						onToggleHunkViewed={onToggleHunkViewed}
						onToggleHunkCollapsed={onToggleHunkCollapsed}
						onToggleFileCollapsed={onToggleFileCollapsed}
					/>
				))
			)}
		</div>
	);
}

interface FilterStatusBarProps {
	label?: string;
	shownHunkCount: number;
	totalHunkCount: number;
	shownFileCount: number;
	totalFileCount: number;
	/** Hide the "X of Y hunks ..." denominator subtitle. Used by filters where the count isn't a meaningful proportion of the tour total. */
	hideCounts?: boolean;
	/** Override the clear-filter button label. Defaults to "Show all". */
	clearLabel?: string;
	onClearFilter: () => void;
}

function pluralHunks(n: number): string {
	return n === 1 ? 'hunk' : 'hunks';
}

function pluralFiles(n: number): string {
	return n === 1 ? 'file' : 'files';
}

function FilterStatusBar({ label, shownHunkCount, totalHunkCount, shownFileCount, totalFileCount, hideCounts, clearLabel, onClearFilter }: FilterStatusBarProps) {
	return (
		<div className="viewer-filter-status" role="status" aria-live="polite">
			<div className="viewer-filter-status-text">
				<span className="viewer-filter-status-label">
					Filtered to <strong>{label ?? 'selected section'}</strong>
				</span>
				{!hideCounts && (
					<span className="viewer-filter-status-counts">
						{shownHunkCount} of {totalHunkCount} {pluralHunks(totalHunkCount)}
						{' · '}
						{shownFileCount} of {totalFileCount} {pluralFiles(totalFileCount)}
					</span>
				)}
			</div>
			<Tooltip text="Clear the section filter and show all hunks">
				<button
					type="button"
					className="viewer-filter-status-clear secondary"
					onClick={onClearFilter}
				>
					{clearLabel ?? 'Show all'}
				</button>
			</Tooltip>
		</div>
	);
}

interface FileGroupBlockProps {
	diffLayout: 'inline' | 'sideBySide';
	headSha?: string;
	outdatedHunkIds?: Set<string>;
	file: string;
	hunks: TourHunkNode[];
	/** Active duplicate set per rendered card. See {@link ViewerRightPaneProps.activeNodesByKey}. */
	activeNodesByKey: Map<string, TourHunkNode[]>;
	totalHunksForFile: number;
	threadsByHunkId: Map<string, IReviewThread[]>;
	associatedHunkKeys: Set<string>;
	showHighlights: boolean;
	onOpenDiff: (hunk: HunkReference) => void;
	onPostLineComment: (hunk: HunkReference, target: CommentTarget, body: string) => Promise<void>;
	onReplyToThread: (thread: IReviewThread, body: string) => Promise<void>;
	commentsEnabled: boolean;
	commentsDisabledReason?: string;
	openDiffDisabled: boolean;
	openDiffDisabledReason?: string;
	viewedHunks: Set<string>;
	collapsedHunks: Set<string>;
	isFileCollapsed: boolean;
	onToggleHunkViewed: (key: string) => void;
	onToggleHunkCollapsed: (key: string) => void;
	onToggleFileCollapsed: (file: string) => void;
}

function FileGroupBlock({
	diffLayout,
	headSha,
	outdatedHunkIds,
	file,
	hunks,
	activeNodesByKey,
	totalHunksForFile,
	threadsByHunkId,
	associatedHunkKeys,
	showHighlights,
	onOpenDiff,
	onPostLineComment,
	onReplyToThread,
	commentsEnabled,
	commentsDisabledReason,
	openDiffDisabled,
	openDiffDisabledReason,
	viewedHunks,
	collapsedHunks,
	isFileCollapsed,
	onToggleHunkViewed,
	onToggleHunkCollapsed,
	onToggleFileCollapsed,
}: FileGroupBlockProps) {
	const shown = hunks.length;
	const total = totalHunksForFile;
	const countText = total > shown
		? `${shown} of ${total} ${pluralHunks(total)}`
		: `${shown} ${pluralHunks(shown)}`;
	const handleHeaderClick = isFileCollapsed
		? (e: React.MouseEvent<HTMLDivElement>) => {
			const target = e.target as HTMLElement;
			if (target.closest('button, label, input, a')) {
				return;
			}
			onToggleFileCollapsed(file);
		}
		: undefined;
	return (
		<div className={`viewer-file-group${isFileCollapsed ? ' viewer-file-group-collapsed' : ''}`}>
			<div
				className="viewer-file-group-header"
				title={isFileCollapsed ? `Click to expand ${file}` : file}
				onClick={handleHeaderClick}
			>
				<Tooltip text={isFileCollapsed ? 'Expand file' : 'Collapse file'}>
					<span
						role="button"
						tabIndex={0}
						className={`expand-icon icon-button viewer-file-collapse-toggle${isFileCollapsed ? ' closed' : ''}`}
						onClick={e => { e.stopPropagation(); onToggleFileCollapsed(file); }}
						onKeyDown={e => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								e.stopPropagation();
								onToggleFileCollapsed(file);
							}
						}}
					>
						{chevronDownIcon}
					</span>
				</Tooltip>
				<span className="viewer-file-group-name">{file}</span>
				<span className="viewer-file-group-count">{countText}</span>
			</div>
			{!isFileCollapsed && hunks.map(node => {
				const key = hunkKeyFor(node.hunk);
				const active = activeNodesByKey.get(key) ?? [node];
				// Concatenate highlights from every active occurrence rather than
				// reading the dedup rep's `node.hunk.highlights`. When a paragraph
				// is selected, `active` is just that paragraph's adjacent
				// duplicate(s), so the rendered highlights track the paragraph
				// the user clicked on.
				const highlights: HighlightRange[] | undefined = (() => {
					const merged: HighlightRange[] = [];
					for (const a of active) {
						if (a.hunk.highlights) {
							merged.push(...a.hunk.highlights);
						}
					}
					return merged.length > 0 ? merged : undefined;
				})();
				return (
					<HunkCard
						key={node.id}
						diffLayout={diffLayout}
						headSha={headSha}
						isOutdated={outdatedHunkIds?.has(node.id) ?? false}
						node={node}
						summary={aggregateHunkSummary(active)}
						highlights={highlights}
						threads={threadsByHunkId.get(node.id) ?? []}
						associated={associatedHunkKeys.has(key)}
						showHighlights={showHighlights}
						onOpenDiff={onOpenDiff}
						onPostLineComment={onPostLineComment}
						onReplyToThread={onReplyToThread}
						commentsEnabled={commentsEnabled}
						commentsDisabledReason={commentsDisabledReason}
						openDiffDisabled={openDiffDisabled}
						openDiffDisabledReason={openDiffDisabledReason}
						hunkKey={key}
						isViewed={viewedHunks.has(key)}
						isCollapsed={collapsedHunks.has(key)}
						onToggleViewed={onToggleHunkViewed}
						onToggleCollapsed={onToggleHunkCollapsed}
					/>
				);
			})}
		</div>
	);
}

interface HunkCardProps {
	diffLayout: 'inline' | 'sideBySide';
	headSha?: string;
	/** True when this hunk's file has drifted since the tour was authored. Drives the badge. */
	isOutdated: boolean;
	node: TourHunkNode;
	/** Aggregated summary across all duplicate occurrences of this hunk; see {@link aggregateHunkSummary}. */
	summary: { text: string; isAuto: boolean };
	/** Highlight ranges merged across the currently active duplicates (not `node.hunk.highlights`). Drives the line-highlight overlay together with `associated`. */
	highlights: HighlightRange[] | undefined;
	threads: IReviewThread[];
	associated: boolean;
	showHighlights: boolean;
	onOpenDiff: (hunk: HunkReference) => void;
	onPostLineComment: (hunk: HunkReference, target: CommentTarget, body: string) => Promise<void>;
	onReplyToThread: (thread: IReviewThread, body: string) => Promise<void>;
	commentsEnabled: boolean;
	commentsDisabledReason?: string;
	openDiffDisabled: boolean;
	openDiffDisabledReason?: string;
	hunkKey: string;
	isViewed: boolean;
	isCollapsed: boolean;
	onToggleViewed: (key: string) => void;
	onToggleCollapsed: (key: string) => void;
}

function targetForLine(line: ParsedDiffLine): CommentTarget | undefined {
	if (line.type === 'delete' && line.oldLine !== undefined) {
		return { line: line.oldLine, side: 'LEFT' };
	}
	if (line.newLine !== undefined) {
		return { line: line.newLine, side: 'RIGHT' };
	}
	if (line.oldLine !== undefined) {
		return { line: line.oldLine, side: 'LEFT' };
	}
	return undefined;
}

function threadAttachesToLine(thread: IReviewThread, line: ParsedDiffLine): boolean {
	if (thread.diffSide === DiffSide.LEFT) {
		return line.oldLine !== undefined && line.oldLine === thread.originalEndLine;
	}
	return line.newLine !== undefined && line.newLine === thread.endLine;
}

function HunkCard({ diffLayout, headSha, isOutdated, node, summary, highlights, threads, associated, showHighlights, onOpenDiff, onPostLineComment, onReplyToThread, commentsEnabled, commentsDisabledReason, openDiffDisabled, openDiffDisabledReason, hunkKey, isViewed, isCollapsed, onToggleViewed, onToggleCollapsed }: HunkCardProps) {
	const { file, startLine, endLine, patch } = node.hunk;
	const headShaShort = headSha ? headSha.substring(0, 7) : '';
	const isPinned = !!node.hunk.pinned;
	const lines = useMemo(() => patch ? parsePatch(patch) : [], [patch]);
	const summaryInfo = summary;
	const diffHunkHeaderText = useMemo(() => {
		const h = lines.find(l => l.type === 'hunk-header');
		return h?.content ?? `@@ L${startLine}-${endLine} @@`;
	}, [lines, startLine, endLine]);
	const highlightedLineIndices = useMemo(() => {
		if (!associated || !showHighlights) {
			return undefined;
		}
		return indicesFromHighlights(lines, highlights);
	}, [associated, showHighlights, lines, highlights]);

	const [composerLineIdx, setComposerLineIdx] = useState<number | null>(null);

	const handleAddCommentForLine = useCallback((idx: number) => {
		if (!commentsEnabled) return;
		setComposerLineIdx(idx);
	}, [commentsEnabled]);

	const handleCancelComposer = useCallback(() => setComposerLineIdx(null), []);

	const handleSubmitComposer = useCallback(async (body: string) => {
		if (composerLineIdx === null) return;
		const target = targetForLine(lines[composerLineIdx]);
		if (!target) return;
		await onPostLineComment(node.hunk, target, body);
		setComposerLineIdx(null);
	}, [composerLineIdx, lines, node.hunk, onPostLineComment]);

	const threadWidgetsByLineIdx = useMemo(() => {
		const map = new Map<number, React.ReactNode>();
		if (threads.length === 0) {
			return map;
		}
		// Group threads by line index where each attaches.
		const buckets = new Map<number, IReviewThread[]>();
		for (const thread of threads) {
			for (let i = 0; i < lines.length; i++) {
				if (threadAttachesToLine(thread, lines[i])) {
					const arr = buckets.get(i) ?? [];
					arr.push(thread);
					buckets.set(i, arr);
					break;
				}
			}
		}
		for (const [idx, arr] of buckets) {
			map.set(idx, (
				<div className="vc-thread-stack">
					{arr.map(thread => (
						<InlineCommentThread
							key={thread.id}
							thread={thread}
							onReply={onReplyToThread}
							replyDisabled={!commentsEnabled}
							replyDisabledReason={commentsDisabledReason}
						/>
					))}
				</div>
			));
		}
		return map;
	}, [threads, lines, onReplyToThread, commentsEnabled, commentsDisabledReason]);

	const composerNode = composerLineIdx !== null ? (() => {
		const target = targetForLine(lines[composerLineIdx]);
		const label = target ? `New thread on ${target.side === 'LEFT' ? 'old' : 'new'} line ${target.line}` : 'New thread';
		return (
			<InlineCommentComposer
				targetLabel={label}
				onSubmit={handleSubmitComposer}
				onCancel={handleCancelComposer}
			/>
		);
	})() : null;

	const bodyCollapsed = isCollapsed;
	const handleHeaderClick = bodyCollapsed
		? (e: React.MouseEvent<HTMLDivElement>) => {
			// Ignore clicks that originate from inner interactive controls.
			const target = e.target as HTMLElement;
			if (target.closest('button, label, input, a')) {
				return;
			}
			onToggleCollapsed(hunkKey);
		}
		: undefined;
	return (
		<div
			id={`viewer-hunk-${node.id}`}
			className={`viewer-hunk-card${associated ? ' viewer-hunk-associated' : ''}${isViewed ? ' viewer-hunk-viewed' : ''}${bodyCollapsed ? ' viewer-hunk-collapsed' : ''}`}
		>
			<div
				className="viewer-hunk-header"
				onClick={handleHeaderClick}
				title={bodyCollapsed ? `Click to expand (L${startLine}-${endLine}${headShaShort ? ` @ ${headShaShort}` : ''})` : undefined}
			>
				{/* Row 1: chevron, L#-# + ref (no file - the file is already in the
					file group header in the left pane), actions. */}
				<div className="viewer-hunk-header-row viewer-hunk-header-row-meta">
					<Tooltip text={bodyCollapsed ? 'Expand hunk' : 'Collapse hunk'}>
						<span
							role="button"
							tabIndex={0}
							className={`expand-icon icon-button viewer-hunk-collapse-toggle${bodyCollapsed ? ' closed' : ''}`}
							onClick={e => { e.stopPropagation(); onToggleCollapsed(hunkKey); }}
							onKeyDown={e => {
								if (e.key === 'Enter' || e.key === ' ') {
									e.preventDefault();
									e.stopPropagation();
									onToggleCollapsed(hunkKey);
								}
							}}
						>
							{chevronDownIcon}
						</span>
					</Tooltip>
					<div className="viewer-hunk-info">
						<span className="viewer-hunk-lines">L{startLine}&ndash;{endLine}</span>
						{headShaShort && (
						<span className="viewer-hunk-ref" title={headSha}>{headShaShort}</span>
					)}
					{isOutdated && isPinned && (
						<span className="tour-hunk-badge tour-hunk-badge-pinned" title="This hunk's file has drifted from the PR. The author pinned it as history (the tour is not flagged outdated because of this hunk).">
							History (Pinned)
						</span>
					)}
					{isOutdated && !isPinned && (
						<span className="tour-hunk-badge tour-hunk-badge-outdated" title="This hunk's file has drifted from the PR since the tour was authored.">
							Outdated
						</span>
					)}
					{node.id.startsWith('__excluded_synthetic_') && (
						<span className="tour-hunk-badge tour-hunk-badge-excluded" title="The author marked this PR hunk as excluded from the tour's drift / coverage report.">
							Excluded
						</span>
					)}
					</div>
					<Tooltip text={openDiffDisabled ? openDiffDisabledReason ?? 'Open in file context' : 'Open in file context'}>
						<button
							type="button"
							className="viewer-hunk-action icon-button"
							aria-label="Open in file context"
							disabled={openDiffDisabled}
							onClick={e => { e.stopPropagation(); onOpenDiff(node.hunk); }}
						>
							{diffSingleIcon}
						</button>
					</Tooltip>
					<Tooltip text={isViewed ? 'Mark hunk as unviewed' : 'Mark hunk as viewed'}>
						<label
							className={`viewer-viewed-checkbox${isViewed ? ' is-viewed' : ''}`}
							onClick={e => e.stopPropagation()}
						>
							<span className="checkbox-wrapper">
								<input
									type="checkbox"
									checked={isViewed}
									onChange={() => onToggleViewed(hunkKey)}
								/>
							</span>
							<span className="viewer-viewed-checkbox-label">Viewed</span>
						</label>
					</Tooltip>
				</div>
				{/* Row 2: read-only summary text. */}
				<div className="viewer-hunk-header-row viewer-hunk-header-row-summary">
					<span
						className={`viewer-hunk-summary${summaryInfo.isAuto ? ' viewer-hunk-summary-auto' : ''}`}
						title={summaryInfo.text}
					>
						{summaryInfo.text}
					</span>
				</div>
				{/* Row 3: native `@@` patch header line (always visible). */}
				<div className="viewer-hunk-header-row viewer-hunk-header-row-diff" title={diffHunkHeaderText}>
					{diffHunkHeaderText}
				</div>
			</div>
			{!bodyCollapsed && (
				lines.length > 0 ? (
					<DiffTable
						layout={diffLayout}
						lines={lines}
						highlightedLineIndices={highlightedLineIndices}
						onAddCommentForLine={commentsEnabled ? handleAddCommentForLine : undefined}
						composerLineIdx={composerLineIdx}
						composerNode={composerNode}
						threadWidgetsByLineIdx={threadWidgetsByLineIdx}
					/>
				) : (
					<div className="viewer-hunk-placeholder">
						Diff hunk from <strong>{file}</strong> lines {startLine}-{endLine}
					</div>
				)
			)}
		</div>
	);
}

function cssEscape(s: string): string {
	const browserWindow = window as Window & typeof globalThis;
	if (typeof browserWindow.CSS?.escape === 'function') {
		return browserWindow.CSS.escape(s);
	}
	return s.replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`);
}
