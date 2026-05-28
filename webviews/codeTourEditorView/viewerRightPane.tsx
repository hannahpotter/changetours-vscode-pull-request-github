/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { InlineCommentComposer } from './inlineCommentComposer';
import { InlineCommentThread } from './inlineCommentThread';
import type { FileHunkGroup } from './viewerModel';
import { DiffSide, type IReviewThread } from '../../src/common/comment';
import type { HunkReference, TourHunkNode } from '../../src/github/codeTourMarkdown';
import { indicesFromHighlights } from '../common/diffHighlights';
import { DiffTable } from '../common/DiffTable';
import { ParsedDiffLine, parsePatch } from '../common/diffUtils';
import { diffSingleIcon } from '../components/icon';

export interface CommentTarget {
	line: number;
	side: 'LEFT' | 'RIGHT';
}

interface ViewerRightPaneProps {
	fileGroups: FileHunkGroup[];
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
	emptyMessage?: string;
}

export function ViewerRightPane({
	fileGroups,
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
	emptyMessage,
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
			<div className="viewer-right-toolbar">
				<label className="viewer-toolbar-toggle">
					<input
						type="checkbox"
						checked={showHighlights}
						onChange={onToggleHighlights}
					/>
					<span>Show paragraph highlights</span>
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
						threadsByHunkId={threadsByHunkId}
						associatedHunkIds={associatedHunkIds}
						showHighlights={showHighlights}
						onOpenDiff={onOpenDiff}
						onPostLineComment={onPostLineComment}
						onReplyToThread={onReplyToThread}
						commentsEnabled={commentsEnabled}
						commentsDisabledReason={commentsDisabledReason}
					/>
				))
			)}
		</div>
	);
}

interface FileGroupBlockProps {
	file: string;
	hunks: TourHunkNode[];
	threadsByHunkId: Map<string, IReviewThread[]>;
	associatedHunkIds: Set<string>;
	showHighlights: boolean;
	onOpenDiff: (hunk: HunkReference) => void;
	onPostLineComment: (hunk: HunkReference, target: CommentTarget, body: string) => Promise<void>;
	onReplyToThread: (thread: IReviewThread, body: string) => Promise<void>;
	commentsEnabled: boolean;
	commentsDisabledReason?: string;
}

function FileGroupBlock({
	file,
	hunks,
	threadsByHunkId,
	associatedHunkIds,
	showHighlights,
	onOpenDiff,
	onPostLineComment,
	onReplyToThread,
	commentsEnabled,
	commentsDisabledReason,
}: FileGroupBlockProps) {
	return (
		<div className="viewer-file-group">
			<div className="viewer-file-group-header" title={file}>{file}</div>
			{hunks.map(node => (
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
				/>
			))}
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

function HunkCard({ node, threads, associated, showHighlights, onOpenDiff, onPostLineComment, onReplyToThread, commentsEnabled, commentsDisabledReason }: HunkCardProps) {
	const { file, startLine, endLine, ref, patch } = node.hunk;
	const lines = useMemo(() => patch ? parsePatch(patch) : [], [patch]);
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

	return (
		<div
			id={`viewer-hunk-${node.id}`}
			className={`viewer-hunk-card${associated ? ' viewer-hunk-associated' : ''}`}
		>
			<div className="viewer-hunk-header">
				<span className="viewer-hunk-lines">L{startLine}-{endLine}</span>
				<span className="viewer-hunk-ref" title={ref}>{ref.substring(0, 7)}</span>
				<button
					type="button"
					className="viewer-hunk-action secondary"
					title="Open this file's full diff with comments and context"
					onClick={() => onOpenDiff(node.hunk)}
				>
					<span className="viewer-hunk-action-icon">{diffSingleIcon}</span>
					Open in diff
				</button>
			</div>
			{lines.length > 0 ? (
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
