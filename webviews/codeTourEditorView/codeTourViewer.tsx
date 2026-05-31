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
	hunkKeyFor,
	hunksForSection,
} from './viewerModel';
import { type CommentTarget, ViewerRightPane } from './viewerRightPane';
import { DiffSide, type IComment, type IReviewThread } from '../../src/common/comment';
import type { CodeTourDocument, HunkReference, TourGroupNode, TourNode, TourTextNode } from '../../src/github/codeTourMarkdown';

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
	| { command: 'codeTourViewer.addComment'; args: { requestId: string; prNumber: number | undefined; prOwner: string | undefined; prRepo: string | undefined; file: string; startLine?: number; endLine: number; side: CommentTarget['side']; body: string } }
	| { command: 'codeTourViewer.replyToThread'; args: { requestId: string; prNumber: number | undefined; prOwner: string | undefined; prRepo: string | undefined; threadId: string; inReplyToCommentNodeId: string; body: string } };

interface CodeTourViewerProps {
	doc: CodeTourDocument;
	activePR?: {
		number: number;
		owner: string;
		repo: string;
		baseOwner?: string;
		baseRepo?: string;
		headOwner?: string;
		headRepo?: string;
	};
	postMessage: (msg: ViewerOutboundMessage) => Promise<unknown>;
	inbox: ViewerInboxMessage | undefined;
	onOpenDiff: (hunk: HunkReference) => void;
	initialViewedKeys: string[];
	persistViewed: (keys: string[]) => void;
	tourFilePath: string | undefined;
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

function collectTextNodes(doc: CodeTourDocument): TourTextNode[] {
	const out: TourTextNode[] = [];
	const walk = (nodes: TourNode[]) => {
		for (const n of nodes) {
			if (n.type === 'text') {
				out.push(n);
			} else if (n.type === 'group') {
				walk(n.children);
			}
		}
	};
	walk(doc.children);
	return out;
}

export function CodeTourViewer({ doc, activePR, postMessage, inbox, onOpenDiff, initialViewedKeys, persistViewed, tourFilePath }: CodeTourViewerProps) {
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
	// Session-only manual collapse for entire file groups (keyed by file path).
	// Same shape as collapsedHunks: auto-flipped when all of a file's currently-shown
	// hunks become viewed (and back when one un-views), but independently togglable.
	const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(() => {
		const seeded = new Set(initialViewedKeys);
		const out = new Set<string>();
		for (const fg of dedupAndGroupByFile(flattenHunks(doc))) {
			if (fg.hunks.length > 0 && fg.hunks.every(h => seeded.has(hunkKeyFor(h.hunk)))) {
				out.add(fg.file);
			}
		}
		return out;
	});
	const viewedHunksRef = useRef<Set<string>>(viewedHunks);
	const docRef = useRef(doc);
	useEffect(() => { docRef.current = doc; }, [doc]);
	// Ref to the currently-rendered file groups. Read inside hunk/section toggle
	// callbacks so we can auto-collapse a file whose visible hunks all become
	// viewed without re-binding the callbacks on every filter change.
	const fileGroupsRef = useRef<Array<{ file: string; keys: string[] }>>([]);

	// Re-seed when the host re-sends initial state (e.g. document reopen).
	useEffect(() => {
		const seeded = new Set(initialViewedKeys);
		viewedHunksRef.current = seeded;
		setViewedHunks(seeded);
		setCollapsedHunks(new Set(initialViewedKeys));
		const seededFiles = new Set<string>();
		for (const fg of dedupAndGroupByFile(flattenHunks(docRef.current))) {
			if (fg.hunks.length > 0 && fg.hunks.every(h => seeded.has(hunkKeyFor(h.hunk)))) {
				seededFiles.add(fg.file);
			}
		}
		setCollapsedFiles(seededFiles);
	}, [initialViewedKeys]);

	useEffect(() => {
		viewedHunksRef.current = viewedHunks;
	}, [viewedHunks]);

	const prBound = !!doc.isPR && !!doc.prNumber && !!doc.prOwner && !!doc.prRepo;
	// A tour matches the active PR if the numbers agree and ANY of the active
	// PR's known identifiers (its tracking remote, base, or head) matches the
	// frontmatter. This handles forks where the tour was authored against the
	// upstream while the local repo tracks the fork (or vice versa).
	const prMatchesActive = (() => {
		if (!prBound || !activePR || activePR.number !== doc.prNumber) {
			return false;
		}
		const tourOwner = doc.prOwner?.toLowerCase();
		const tourRepo = doc.prRepo?.toLowerCase();
		const candidates: Array<{ owner?: string; repo?: string }> = [
			{ owner: activePR.owner, repo: activePR.repo },
			{ owner: activePR.baseOwner, repo: activePR.baseRepo },
			{ owner: activePR.headOwner, repo: activePR.headRepo },
		];
		return candidates.some(c =>
			c.owner?.toLowerCase() === tourOwner && c.repo?.toLowerCase() === tourRepo,
		);
	})();
	const commentsEnabled = prBound && prMatchesActive;
	const commentsDisabledReason = !prBound
		? 'Comments require a Change Tour bound to a pull request.'
		: !prMatchesActive
			? `Checkout PR #${doc.prNumber} to add or load comments.`
			: undefined;
	const openDiffDisabled = prBound && !prMatchesActive;
	const openDiffDisabledReason = openDiffDisabled
		? `Checkout PR #${doc.prNumber} to open in file context.`
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
		} else {
			setSelectedSectionId(undefined);
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

	const reconcileFileCollapse = useCallback((nextViewed: Set<string>, touchedFiles: Set<string>) => {
		if (touchedFiles.size === 0) {
			return;
		}
		setCollapsedFiles(prev => {
			const nextF = new Set(prev);
			for (const fg of fileGroupsRef.current) {
				if (!touchedFiles.has(fg.file)) {
					continue;
				}
				if (fg.keys.length > 0 && fg.keys.every(k => nextViewed.has(k))) {
					nextF.add(fg.file);
				} else {
					nextF.delete(fg.file);
				}
			}
			return nextF;
		});
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
		const touched = new Set<string>();
		for (const fg of fileGroupsRef.current) {
			if (fg.keys.includes(key)) {
				touched.add(fg.file);
			}
		}
		reconcileFileCollapse(next, touched);
		persistViewed([...next]);
	}, [persistViewed, reconcileFileCollapse]);

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

	const handleToggleFileCollapsed = useCallback((file: string) => {
		setCollapsedFiles(prev => {
			const next = new Set(prev);
			if (next.has(file)) {
				next.delete(file);
			} else {
				next.add(file);
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
		const touched = new Set<string>();
		const affectedKeys = new Set(keys);
		for (const fg of fileGroupsRef.current) {
			if (fg.keys.some(k => affectedKeys.has(k))) {
				touched.add(fg.file);
			}
		}
		reconcileFileCollapse(next, touched);
		persistViewed([...next]);
	}, [persistViewed, reconcileFileCollapse]);


	const allFileGroups = useMemo(() => dedupAndGroupByFile(flattenHunks(doc)), [doc]);

	const selectedSection = useMemo(() => {
		if (!selectedSectionId) {
			return undefined;
		}
		const node = findNode(doc, selectedSectionId);
		return node && node.type === 'group' ? node : undefined;
	}, [doc, selectedSectionId]);

	const fileGroups = useMemo(() => {
		if (selectedSectionId) {
			return dedupAndGroupByFile(selectedSection ? hunksForSection(selectedSection) : []);
		}
		return allFileGroups;
	}, [allFileGroups, selectedSection, selectedSectionId]);

	useEffect(() => {
		fileGroupsRef.current = fileGroups.map(fg => ({
			file: fg.file,
			keys: fg.hunks.map(h => hunkKeyFor(h.hunk)),
		}));
	}, [fileGroups]);

	const totalsByFile = useMemo(() => {
		const m = new Map<string, number>();
		for (const fg of allFileGroups) {
			m.set(fg.file, fg.hunks.length);
		}
		return m;
	}, [allFileGroups]);

	const totalHunkCount = useMemo(() => allFileGroups.reduce((n, fg) => n + fg.hunks.length, 0), [allFileGroups]);
	const totalFileCount = allFileGroups.length;
	const shownHunkCount = useMemo(() => fileGroups.reduce((n, fg) => n + fg.hunks.length, 0), [fileGroups]);
	const shownFileCount = fileGroups.length;
	const isFiltering = !!selectedSectionId;
	const filterLabel = isFiltering ? (selectedSection?.title || 'Selected section') : undefined;

	const handleClearFilter = useCallback(() => {
		setSelectedSectionId(undefined);
		setSelectedTextNodeId(undefined);
	}, []);

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

	// Threads attached to the .changetour.md file itself (paragraph-level comments).
	// Key = text-node id; value = threads whose RIGHT-side range overlaps the paragraph.
	const threadsByTextNodeId = useMemo(() => {
		const map = new Map<string, IReviewThread[]>();
		if (!tourFilePath) {
			return map;
		}
		const textNodes = collectTextNodes(doc);
		const tourThreads = threads.filter(t => t.diffSide === DiffSide.RIGHT && t.path === tourFilePath);
		for (const node of textNodes) {
			if (node.sourceStartLine === undefined || node.sourceEndLine === undefined) {
				continue;
			}
			const matched = tourThreads.filter(t => rangesOverlap(t.startLine, t.endLine, node.sourceStartLine!, node.sourceEndLine!));
			if (matched.length > 0) {
				map.set(node.id, matched);
			}
		}
		return map;
	}, [doc, threads, tourFilePath]);

	const tourCommentsEnabled = commentsEnabled && !!tourFilePath;
	const tourCommentsDisabledReason = !tourFilePath
		? 'This tour file is not inside the active repository, so paragraph comments cannot be posted to GitHub.'
		: commentsDisabledReason;

	const handlePostTourFileComment = useCallback((node: TourTextNode, body: string) => {
		if (!tourCommentsEnabled || !tourFilePath) {
			return Promise.reject(new Error(tourCommentsDisabledReason ?? 'Comments unavailable.'));
		}
		if (node.sourceStartLine === undefined || node.sourceEndLine === undefined) {
			return Promise.reject(new Error('This paragraph has no known source line range; cannot post a comment.'));
		}
		const requestId = `viewer-tourcomment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const startLine = node.sourceStartLine;
		const endLine = node.sourceEndLine;
		return new Promise<void>((resolve, reject) => {
			pendingCommentsRef.current.set(requestId, { resolve, reject });
			postMessage({
				command: 'codeTourViewer.addComment',
				args: {
					requestId,
					prNumber: doc.prNumber,
					prOwner: doc.prOwner,
					prRepo: doc.prRepo,
					file: tourFilePath,
					startLine: startLine === endLine ? undefined : startLine,
					endLine,
					side: 'RIGHT',
					body,
				},
			});
		});
	}, [tourCommentsEnabled, tourCommentsDisabledReason, tourFilePath, doc.prNumber, doc.prOwner, doc.prRepo, postMessage]);

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
				threadsByTextNodeId={threadsByTextNodeId}
				onPostTextNodeComment={handlePostTourFileComment}
				onReplyToThread={handleReplyToThread}
				tourCommentsEnabled={tourCommentsEnabled}
				tourCommentsDisabledReason={tourCommentsDisabledReason}
			/>
			<ViewerRightPane
				fileGroups={fileGroups}
				totalsByFile={totalsByFile}
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
				openDiffDisabled={openDiffDisabled}
				openDiffDisabledReason={openDiffDisabledReason}
				isFiltering={isFiltering}
				filterLabel={filterLabel}
				shownHunkCount={shownHunkCount}
				totalHunkCount={totalHunkCount}
				shownFileCount={shownFileCount}
				totalFileCount={totalFileCount}
				onClearFilter={handleClearFilter}
				emptyMessage={selectedSectionId ? 'This section has no hunks.' : 'No hunks in this tour yet.'}
				viewedHunks={viewedHunks}
				collapsedHunks={collapsedHunks}
				collapsedFiles={collapsedFiles}
				onToggleHunkViewed={handleToggleHunkViewed}
				onToggleHunkCollapsed={handleToggleHunkCollapsed}
				onToggleFileCollapsed={handleToggleFileCollapsed}
			/>
		</div>
	);
}
