/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ViewerLeftPane } from './viewerLeftPane';
import {
	associatedHunkIds as computeAssociatedHunkIds,
	dedupAndGroupByFile,
	descendantHunkKeys,
	findNode,
	findParentGroup,
	flattenHunks,
	hunksForSection,
} from './viewerModel';
import { type CommentTarget, ViewerRightPane } from './viewerRightPane';
import { DiffSide, type IComment, type IReviewThread } from '../../src/common/comment';
import type { CodeTourDocument, HunkReference, TourGroupNode, TourHunkNode } from '../../src/github/codeTourMarkdown';

interface ViewerLoadThreadsMessage {
	command: 'codeTourViewer.threadsLoaded';
	threads: IReviewThread[];
}

interface ViewerCommentPostedMessage {
	command: 'codeTourViewer.commentPosted';
	requestId: string;
	thread?: IReviewThread;
}

interface ViewerReplyPostedMessage {
	command: 'codeTourViewer.replyPosted';
	requestId: string;
	threadId?: string;
	comment: IComment;
}

interface ViewerCommentErrorMessage {
	command: 'codeTourViewer.commentError';
	requestId: string;
	error?: string;
}

export type ViewerInboxPayload = ViewerLoadThreadsMessage | ViewerCommentPostedMessage | ViewerReplyPostedMessage | ViewerCommentErrorMessage;

export interface ViewerInboxMessage {
	ts: number;
	message: ViewerInboxPayload;
}

type ViewerOutboundMessage =
	| { command: 'codeTourViewer.loadThreads'; args: { prNumber: number | undefined; prOwner: string | undefined; prRepo: string | undefined } }
	| { command: 'codeTourViewer.addComment'; args: { requestId: string; prNumber: number | undefined; prOwner: string | undefined; prRepo: string | undefined; file: string; endLine: number; side: CommentTarget['side']; body: string } }
	| { command: 'codeTourViewer.replyToThread'; args: { requestId: string; prNumber: number | undefined; prOwner: string | undefined; prRepo: string | undefined; threadId: string; inReplyToCommentNodeId: string; body: string } };

interface CodeTourViewerProps {
	doc: CodeTourDocument;
	activePR?: { number: number; owner: string; repo: string };
	postMessage: (msg: ViewerOutboundMessage) => Promise<unknown>;
	inbox: ViewerInboxMessage | undefined;
	onOpenDiff: (hunk: HunkReference) => void;
	initialViewedKeys: string[];
	persistViewed: (keys: string[]) => void;
}

interface PendingComment {
	resolve: () => void;
	reject: (err: Error) => void;
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
	return aStart <= bEnd && bStart <= aEnd;
}

function threadOverlapsHunk(thread: IReviewThread, hunk: HunkReference): boolean {
	if (thread.diffSide === DiffSide.LEFT) {
		const path = hunk.previousFile ?? hunk.file;
		if (thread.path !== path) {
			return false;
		}
		return rangesOverlap(thread.originalStartLine, thread.originalEndLine, hunk.startLine, hunk.endLine);
	}
	if (thread.path !== hunk.file) {
		return false;
	}
	return rangesOverlap(thread.startLine, thread.endLine, hunk.startLine, hunk.endLine);
}

export function CodeTourViewer({ doc, activePR, postMessage, inbox, onOpenDiff, initialViewedKeys, persistViewed }: CodeTourViewerProps) {
	const [selectedSectionId, setSelectedSectionId] = useState<string | undefined>(undefined);
	const [selectedTextNodeId, setSelectedTextNodeId] = useState<string | undefined>(undefined);
	const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
	const [showHighlights, setShowHighlights] = useState(true);
	const [threads, setThreads] = useState<IReviewThread[]>([]);
	const pendingCommentsRef = useRef<Map<string, PendingComment>>(new Map());

	// Persisted-via-workspaceState "viewed" set, keyed by stable hunk identity.
	const [viewedHunks, setViewedHunks] = useState<Set<string>>(() => new Set(initialViewedKeys));
	// Session-only manual collapse for hunks. Auto-set when viewed flips on, but the
	// reviewer can independently toggle via the hunk header chevron to re-look.
	const [collapsedHunks, setCollapsedHunks] = useState<Set<string>>(() => new Set(initialViewedKeys));
	const viewedHunksRef = useRef<Set<string>>(viewedHunks);

	// Re-seed when the host re-sends initial state (e.g. document reopen).
	useEffect(() => {
		const seeded = new Set(initialViewedKeys);
		viewedHunksRef.current = seeded;
		setViewedHunks(seeded);
		setCollapsedHunks(new Set(initialViewedKeys));
	}, [initialViewedKeys]);

	useEffect(() => {
		viewedHunksRef.current = viewedHunks;
	}, [viewedHunks]);

	const prBound = !!doc.isPR && !!doc.prNumber && !!doc.prOwner && !!doc.prRepo;
	const prMatchesActive = prBound && !!activePR
		&& activePR.number === doc.prNumber
		&& activePR.owner?.toLowerCase() === doc.prOwner?.toLowerCase()
		&& activePR.repo?.toLowerCase() === doc.prRepo?.toLowerCase();
	const commentsEnabled = prBound && prMatchesActive;
	const commentsDisabledReason = !prBound
		? 'Comments require a Change Tour bound to a pull request.'
		: !prMatchesActive
			? `Checkout PR #${doc.prNumber} to add or load comments.`
			: undefined;

	useEffect(() => {
		if (!commentsEnabled) {
			setThreads([]);
			return;
		}
		postMessage({
			command: 'codeTourViewer.loadThreads',
			args: { prNumber: doc.prNumber, prOwner: doc.prOwner, prRepo: doc.prRepo },
		});
	}, [commentsEnabled, doc.prNumber, doc.prOwner, doc.prRepo, postMessage]);

	useEffect(() => {
		if (!inbox) {
			return;
		}
		const m = inbox.message;
		switch (m?.command) {
			case 'codeTourViewer.threadsLoaded':
				setThreads(Array.isArray(m.threads) ? m.threads : []);
				return;
			case 'codeTourViewer.commentPosted': {
				const pending = pendingCommentsRef.current.get(m.requestId);
				if (pending) {
					pendingCommentsRef.current.delete(m.requestId);
					pending.resolve();
				}
				if (m.thread) {
					setThreads(prev => [...prev, m.thread as IReviewThread]);
				}
				return;
			}
			case 'codeTourViewer.replyPosted': {
				const pending = pendingCommentsRef.current.get(m.requestId);
				if (pending) {
					pendingCommentsRef.current.delete(m.requestId);
					pending.resolve();
				}
				if (m.threadId && m.comment) {
					setThreads(prev => prev.map(t => t.id === m.threadId
						? { ...t, comments: [...t.comments, m.comment] }
						: t,
					));
				}
				return;
			}
			case 'codeTourViewer.commentError': {
				const pending = pendingCommentsRef.current.get(m.requestId);
				if (pending) {
					pendingCommentsRef.current.delete(m.requestId);
					pending.reject(new Error(m.error ?? 'Failed to post comment.'));
				}
				return;
			}
		}
	}, [inbox]);

	const handleSelectSection = useCallback((id: string) => {
		setSelectedSectionId(prev => {
			if (prev === id) {
				setSelectedTextNodeId(undefined);
				return undefined;
			}
			setSelectedTextNodeId(undefined);
			return id;
		});
	}, []);

	const handleSelectTextNode = useCallback((textNodeId: string, parentGroupId: string | undefined) => {
		setSelectedTextNodeId(prev => (prev === textNodeId ? undefined : textNodeId));
		if (parentGroupId) {
			setSelectedSectionId(prev => prev === parentGroupId ? prev : parentGroupId);
		}
	}, []);

	const handleToggleCollapse = useCallback((id: string) => {
		setCollapsedSections(prev => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	}, []);

	const handleToggleHighlights = useCallback(() => {
		setShowHighlights(v => !v);
	}, []);

	const handleToggleHunkViewed = useCallback((key: string) => {
		const willBeViewed = !viewedHunksRef.current.has(key);
		const next = new Set(viewedHunksRef.current);
		if (willBeViewed) {
			next.add(key);
		} else {
			next.delete(key);
		}
		viewedHunksRef.current = next;
		setViewedHunks(next);
		setCollapsedHunks(prev => {
			const nextC = new Set(prev);
			if (willBeViewed) {
				nextC.add(key);
			} else {
				nextC.delete(key);
			}
			return nextC;
		});
		persistViewed([...next]);
	}, [persistViewed]);

	const handleToggleHunkCollapsed = useCallback((key: string) => {
		setCollapsedHunks(prev => {
			const next = new Set(prev);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			return next;
		});
	}, []);

	const handleToggleSectionViewed = useCallback((group: TourGroupNode) => {
		const keys = descendantHunkKeys(group);
		if (keys.length === 0) {
			return;
		}
		const allViewed = keys.every(k => viewedHunksRef.current.has(k));
		const next = new Set(viewedHunksRef.current);
		if (allViewed) {
			for (const k of keys) {
				next.delete(k);
			}
		} else {
			for (const k of keys) {
				next.add(k);
			}
		}
		viewedHunksRef.current = next;
		setViewedHunks(next);
		setCollapsedHunks(prev => {
			const nextC = new Set(prev);
			if (allViewed) {
				for (const k of keys) {
					nextC.delete(k);
				}
			} else {
				for (const k of keys) {
					nextC.add(k);
				}
			}
			return nextC;
		});
		// Cascade auto-collapse on the section itself.
		setCollapsedSections(prev => {
			const nextS = new Set(prev);
			if (allViewed) {
				nextS.delete(group.id);
			} else {
				nextS.add(group.id);
			}
			return nextS;
		});
		persistViewed([...next]);
	}, [persistViewed]);


	const fileGroups = useMemo(() => {
		let hunks: TourHunkNode[];
		if (selectedSectionId) {
			const section = findNode(doc, selectedSectionId);
			if (section && section.type === 'group') {
				hunks = hunksForSection(section);
			} else {
				hunks = [];
			}
		} else {
			hunks = flattenHunks(doc);
		}
		return dedupAndGroupByFile(hunks);
	}, [doc, selectedSectionId]);

	const { associatedIds, scrollTargetHunkId } = useMemo(() => {
		if (!selectedTextNodeId) {
			return { associatedIds: new Set<string>(), scrollTargetHunkId: undefined };
		}
		const parent = findParentGroup(doc, selectedTextNodeId);
		const ids = computeAssociatedHunkIds(parent, doc, selectedTextNodeId);
		if (ids.size === 0) {
			return { associatedIds: ids, scrollTargetHunkId: undefined };
		}
		let first: string | undefined;
		outer: for (const fg of fileGroups) {
			for (const n of fg.hunks) {
				if (ids.has(n.id)) {
					first = n.id;
					break outer;
				}
			}
		}
		return { associatedIds: ids, scrollTargetHunkId: first };
	}, [doc, selectedTextNodeId, fileGroups]);

	const threadsByHunkId = useMemo(() => {
		const map = new Map<string, IReviewThread[]>();
		for (const fg of fileGroups) {
			for (const n of fg.hunks) {
				const matched = threads.filter(t => threadOverlapsHunk(t, n.hunk));
				if (matched.length > 0) {
					map.set(n.id, matched);
				}
			}
		}
		return map;
	}, [fileGroups, threads]);

	const handlePostLineComment = useCallback((hunk: HunkReference, target: CommentTarget, body: string) => {
		if (!commentsEnabled) {
			return Promise.reject(new Error(commentsDisabledReason ?? 'Comments unavailable.'));
		}
		const requestId = `viewer-comment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const file = target.side === 'LEFT' ? (hunk.previousFile ?? hunk.file) : hunk.file;
		return new Promise<void>((resolve, reject) => {
			pendingCommentsRef.current.set(requestId, { resolve, reject });
			postMessage({
				command: 'codeTourViewer.addComment',
				args: {
					requestId,
					prNumber: doc.prNumber,
					prOwner: doc.prOwner,
					prRepo: doc.prRepo,
					file,
					endLine: target.line,
					side: target.side,
					body,
				},
			});
		});
	}, [commentsEnabled, commentsDisabledReason, doc.prNumber, doc.prOwner, doc.prRepo, postMessage]);

	const handleReplyToThread = useCallback((thread: IReviewThread, body: string) => {
		if (!commentsEnabled) {
			return Promise.reject(new Error(commentsDisabledReason ?? 'Comments unavailable.'));
		}
		const firstComment = thread.comments[0];
		if (!firstComment) {
			return Promise.reject(new Error('Thread has no comments to reply to.'));
		}
		const requestId = `viewer-reply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		return new Promise<void>((resolve, reject) => {
			pendingCommentsRef.current.set(requestId, { resolve, reject });
			postMessage({
				command: 'codeTourViewer.replyToThread',
				args: {
					requestId,
					prNumber: doc.prNumber,
					prOwner: doc.prOwner,
					prRepo: doc.prRepo,
					threadId: thread.id,
					inReplyToCommentNodeId: firstComment.graphNodeId,
					body,
				},
			});
		});
	}, [commentsEnabled, commentsDisabledReason, doc.prNumber, doc.prOwner, doc.prRepo, postMessage]);

	return (
		<div className="viewer-root">
			<ViewerLeftPane
				doc={doc}
				selectedSectionId={selectedSectionId}
				selectedTextNodeId={selectedTextNodeId}
				collapsedSections={collapsedSections}
				onSelectSection={handleSelectSection}
				onSelectTextNode={handleSelectTextNode}
				onToggleCollapse={handleToggleCollapse}
				viewedHunks={viewedHunks}
				onToggleSectionViewed={handleToggleSectionViewed}
			/>
			<ViewerRightPane
				fileGroups={fileGroups}
				threadsByHunkId={threadsByHunkId}
				associatedHunkIds={associatedIds}
				scrollTargetHunkId={scrollTargetHunkId}
				showHighlights={showHighlights}
				onToggleHighlights={handleToggleHighlights}
				onOpenDiff={onOpenDiff}
				onPostLineComment={handlePostLineComment}
				onReplyToThread={handleReplyToThread}
				commentsEnabled={commentsEnabled}
				commentsDisabledReason={commentsDisabledReason}
				emptyMessage={selectedSectionId ? 'This section has no hunks.' : 'No hunks in this tour yet.'}
				viewedHunks={viewedHunks}
				collapsedHunks={collapsedHunks}
				onToggleHunkViewed={handleToggleHunkViewed}
				onToggleHunkCollapsed={handleToggleHunkCollapsed}
			/>
		</div>
	);
}
