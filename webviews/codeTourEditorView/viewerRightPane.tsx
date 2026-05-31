/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { InlineCommentComposer } from './inlineCommentComposer';
import { InlineCommentThread } from './inlineCommentThread';
import { type FileHunkGroup, hunkKeyFor } from './viewerModel';
import { DiffSide, type IReviewThread } from '../../src/common/comment';
import type { HunkReference, TourHunkNode } from '../../src/github/codeTourMarkdown';
import { indicesFromHighlights } from '../common/diffHighlights';
import { DiffTable } from '../common/DiffTable';
import { ParsedDiffLine, parsePatch } from '../common/diffUtils';
import { chevronDownIcon, diffSingleIcon } from '../components/icon';

export interface CommentTarget {
	line: number;
	side: 'LEFT' | 'RIGHT';
}

interface ViewerRightPaneProps {
	fileGroups: FileHunkGroup[];
	totalsByFile: Map<string, number>;
	threadsByHunkId: Map<string, IReviewThread[]>;
	associatedHunkIds: Set<string>;
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
	onClearFilter: () => void;
	emptyMessage?: string;
	viewedHunks: Set<string>;
	collapsedHunks: Set<string>;
	onToggleHunkViewed: (key: string) => void;
	onToggleHunkCollapsed: (key: string) => void;
}

export function ViewerRightPane({
	fileGroups,
	totalsByFile,
	threadsByHunkId,
	associatedHunkIds,
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
	onClearFilter,
	emptyMessage,
	viewedHunks,
	collapsedHunks,
	onToggleHunkViewed,
	onToggleHunkCollapsed,
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
						file={group.file}
						hunks={group.hunks}
						totalHunksForFile={totalsByFile.get(group.file) ?? group.hunks.length}
						threadsByHunkId={threadsByHunkId}
						associatedHunkIds={associatedHunkIds}
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
						onToggleHunkViewed={onToggleHunkViewed}
						onToggleHunkCollapsed={onToggleHunkCollapsed}
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
	onClearFilter: () => void;
}

function pluralHunks(n: number): string {
	return n === 1 ? 'hunk' : 'hunks';
}

function pluralFiles(n: number): string {
	return n === 1 ? 'file' : 'files';
}

function FilterStatusBar({ label, shownHunkCount, totalHunkCount, shownFileCount, totalFileCount, onClearFilter }: FilterStatusBarProps) {
	return (
		<div className="viewer-filter-status" role="status" aria-live="polite">
			<div className="viewer-filter-status-text">
				<span className="viewer-filter-status-label">
					Filtered to <strong>{label ?? 'selected section'}</strong>
				</span>
				<span className="viewer-filter-status-counts">
					{shownHunkCount} of {totalHunkCount} {pluralHunks(totalHunkCount)}
					{' · '}
					{shownFileCount} of {totalFileCount} {pluralFiles(totalFileCount)}
				</span>
			</div>
			<button
				type="button"
				className="viewer-filter-status-clear secondary"
				onClick={onClearFilter}
				title="Clear the section filter and show all hunks"
			>
				Show all
			</button>
		</div>
	);
}

interface FileGroupBlockProps {
	file: string;
	hunks: TourHunkNode[];
	totalHunksForFile: number;
	threadsByHunkId: Map<string, IReviewThread[]>;
	associatedHunkIds: Set<string>;
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
	onToggleHunkViewed: (key: string) => void;
	onToggleHunkCollapsed: (key: string) => void;
}

function FileGroupBlock({
	file,
	hunks,
	totalHunksForFile,
	threadsByHunkId,
	associatedHunkIds,
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
	onToggleHunkViewed,
	onToggleHunkCollapsed,
}: FileGroupBlockProps) {
	const shown = hunks.length;
	const total = totalHunksForFile;
	const countText = total > shown
		? `${shown} of ${total} ${pluralHunks(total)}`
		: `${shown} ${pluralHunks(shown)}`;
	return (
		<div className="viewer-file-group">
			<div className="viewer-file-group-header" title={file}>
				<span className="viewer-file-group-name">{file}</span>
				<span className="viewer-file-group-count">{countText}</span>
			</div>
			{hunks.map(node => {
				const key = hunkKeyFor(node.hunk);
				return (
					<HunkCard
						key={node.id}
						node={node}
						threads={threadsByHunkId.get(node.id) ?? []}
						associated={associatedHunkIds.has(node.id)}
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
	node: TourHunkNode;
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

function HunkCard({ node, threads, associated, showHighlights, onOpenDiff, onPostLineComment, onReplyToThread, commentsEnabled, commentsDisabledReason, openDiffDisabled, openDiffDisabledReason, hunkKey, isViewed, isCollapsed, onToggleViewed, onToggleCollapsed }: HunkCardProps) {
	const { file, startLine, endLine, ref, patch } = node.hunk;
	const lines = useMemo(() => patch ? parsePatch(patch) : [], [patch]);
	const hunkHeaderText = useMemo(() => {
		const h = lines.find(l => l.type === 'hunk-header');
		return h?.content ?? `@@ L${startLine}-${endLine} @@`;
	}, [lines, startLine, endLine]);
	const highlightedLineIndices = useMemo(() => {
		if (!associated || !showHighlights) {
			return undefined;
		}
		return indicesFromHighlights(lines, node.hunk.highlights);
	}, [associated, showHighlights, lines, node.hunk.highlights]);

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
				title={bodyCollapsed ? `Click to expand (L${startLine}-${endLine} @ ${ref.substring(0, 7)})` : undefined}
			>
				<span
					role="button"
					tabIndex={0}
					className={`expand-icon icon-button viewer-hunk-collapse-toggle${bodyCollapsed ? ' closed' : ''}`}
					title={bodyCollapsed ? 'Expand hunk' : 'Collapse hunk'}
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
				<span className="viewer-hunk-summary" title={`${file} (${ref.substring(0, 7)})`}>{hunkHeaderText}</span>
				<button
					type="button"
					className="viewer-hunk-action icon-button"
					title={openDiffDisabled ? openDiffDisabledReason ?? 'Open in file context' : 'Open in file context'}
					aria-label="Open in file context"
					disabled={openDiffDisabled}
					onClick={e => { e.stopPropagation(); onOpenDiff(node.hunk); }}
				>
					{diffSingleIcon}
				</button>
				<label
					className={`viewer-viewed-checkbox${isViewed ? ' is-viewed' : ''}`}
					title={isViewed ? 'Mark hunk as unviewed' : 'Mark hunk as viewed'}
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
			</div>
			{!bodyCollapsed && (
				lines.length > 0 ? (
					<DiffTable
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
