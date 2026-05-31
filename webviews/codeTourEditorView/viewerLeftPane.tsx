/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as marked from 'marked';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { InlineCommentComposer } from './inlineCommentComposer';
import { InlineCommentThread } from './inlineCommentThread';
import { descendantHunkKeys, isSectionFullyViewed, isSectionPartiallyViewed } from './viewerModel';
import type { IReviewThread } from '../../src/common/comment';
import type {
	CodeTourDocument,
	TourGroupNode,
	TourNode,
	TourTextNode,
} from '../../src/github/codeTourMarkdown';
import { chevronDownIcon } from '../components/icon';

marked.setOptions({ breaks: true });

interface ViewerLeftPaneProps {
	doc: CodeTourDocument;
	selectedSectionId: string | undefined;
	selectedTextNodeId: string | undefined;
	collapsedSections: Set<string>;
	onSelectSection: (id: string) => void;
	onSelectTextNode: (textNodeId: string, parentGroupId: string | undefined) => void;
	onToggleCollapse: (id: string) => void;
	viewedHunks: Set<string>;
	onToggleSectionViewed: (group: TourGroupNode) => void;
	threadsByTextNodeId: Map<string, IReviewThread[]>;
	onPostTextNodeComment: (node: TourTextNode, body: string) => Promise<void>;
	onReplyToThread: (thread: IReviewThread, body: string) => Promise<void>;
	tourCommentsEnabled: boolean;
	tourCommentsDisabledReason?: string;
}

export function ViewerLeftPane(props: ViewerLeftPaneProps) {
	const { doc } = props;
	return (
		<div className="viewer-left">
			<h1 className="viewer-title">{doc.title || 'Untitled Change Tour'}</h1>
			<div className="viewer-left-body">
				{doc.children.map(node => (
					<NodeRenderer key={node.id} node={node} parentGroupId={undefined} {...props} />
				))}
			</div>
		</div>
	);
}

function NodeRenderer({
	node,
	parentGroupId,
	...props
}: ViewerLeftPaneProps & { node: TourNode; parentGroupId: string | undefined }) {
	switch (node.type) {
		case 'group':
			return <GroupBlock node={node} {...props} />;
		case 'text':
			return <TextBlock node={node} parentGroupId={parentGroupId} {...props} />;
		case 'hunk':
			// Hunks aren't shown in the left pane.
			return null;
	}
}

function GroupBlock({
	node,
	selectedSectionId,
	selectedTextNodeId,
	collapsedSections,
	onSelectSection,
	onSelectTextNode,
	onToggleCollapse,
	doc,
	viewedHunks,
	onToggleSectionViewed,
	threadsByTextNodeId,
	onPostTextNodeComment,
	onReplyToThread,
	tourCommentsEnabled,
	tourCommentsDisabledReason,
}: ViewerLeftPaneProps & { node: TourGroupNode }) {
	const collapsed = collapsedSections.has(node.id);
	const selected = selectedSectionId === node.id;

	const hasDescendantHunks = useMemo(() => descendantHunkKeys(node).length > 0, [node]);
	const fullyViewed = useMemo(() => isSectionFullyViewed(node, viewedHunks), [node, viewedHunks]);
	const partiallyViewed = useMemo(() => isSectionPartiallyViewed(node, viewedHunks), [node, viewedHunks]);

	// React doesn't expose `indeterminate` as a prop; set it on the DOM element.
	const checkboxRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (checkboxRef.current) {
			checkboxRef.current.indeterminate = partiallyViewed;
		}
	}, [partiallyViewed]);

	return (
		<div className={`viewer-section viewer-section-level-${node.level}${selected ? ' viewer-section-selected' : ''}${fullyViewed ? ' viewer-section-viewed' : ''}`}>
			<div className="viewer-section-header">
				<span
					className={`expand-icon icon-button ${collapsed ? 'closed' : ''}`}
					title={collapsed ? 'Expand section' : 'Collapse section'}
					onClick={e => { e.stopPropagation(); onToggleCollapse(node.id); }}
				>
					{chevronDownIcon}
				</span>
				<div
					role="button"
					tabIndex={0}
					className="viewer-section-title"
					onClick={() => onSelectSection(node.id)}
					onKeyDown={e => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							onSelectSection(node.id);
						}
					}}
					title={selected ? 'Clear section selection' : 'Show only this section\'s hunks'}
				>
					{node.title || 'Untitled Section'}
				</div>
				{hasDescendantHunks && (
					<label
						className={`viewer-viewed-checkbox${fullyViewed ? ' is-viewed' : ''}`}
						title={
							fullyViewed
								? 'Unmark all hunks in this section'
								: partiallyViewed
									? 'Mark remaining hunks in this section as viewed'
									: 'Mark all hunks in this section as viewed'
						}
						onClick={e => e.stopPropagation()}
					>
						<span className="checkbox-wrapper">
							<input
								ref={checkboxRef}
								type="checkbox"
								checked={fullyViewed}
								onChange={() => onToggleSectionViewed(node)}
							/>
						</span>
						<span className="viewer-viewed-checkbox-label">Viewed</span>
					</label>
				)}
			</div>
			{!collapsed && (
				<div className="viewer-section-body">
					{node.children.map(child => (
						<NodeRenderer
							key={child.id}
							node={child}
							parentGroupId={node.id}
							doc={doc}
							selectedSectionId={selectedSectionId}
							selectedTextNodeId={selectedTextNodeId}
							collapsedSections={collapsedSections}
							onSelectSection={onSelectSection}
							onSelectTextNode={onSelectTextNode}
							onToggleCollapse={onToggleCollapse}
							viewedHunks={viewedHunks}
							onToggleSectionViewed={onToggleSectionViewed}
							threadsByTextNodeId={threadsByTextNodeId}
							onPostTextNodeComment={onPostTextNodeComment}
							onReplyToThread={onReplyToThread}
							tourCommentsEnabled={tourCommentsEnabled}
							tourCommentsDisabledReason={tourCommentsDisabledReason}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function TextBlock({
	node,
	parentGroupId,
	selectedTextNodeId,
	onSelectTextNode,
	threadsByTextNodeId,
	onPostTextNodeComment,
	onReplyToThread,
	tourCommentsEnabled,
	tourCommentsDisabledReason,
}: ViewerLeftPaneProps & { node: TourTextNode; parentGroupId: string | undefined }) {
	const isAssociated = selectedTextNodeId === node.id;
	const rendered = useMemo(() => marked.parse(node.content) as string, [node.content]);
	const threads = threadsByTextNodeId.get(node.id) ?? [];
	const [composerOpen, setComposerOpen] = useState(false);

	const handleSubmit = async (body: string) => {
		await onPostTextNodeComment(node, body);
		setComposerOpen(false);
	};

	const hasSourceLines = node.sourceStartLine !== undefined && node.sourceEndLine !== undefined;
	const canStartComment = tourCommentsEnabled && hasSourceLines;
	const triggerTitle = !tourCommentsEnabled
		? tourCommentsDisabledReason ?? 'Comments unavailable'
		: !hasSourceLines
			? 'This paragraph has no known source line range'
			: 'Comment on this paragraph';

	return (
		<div className="viewer-text-wrapper">
			<div
				id={`viewer-text-${node.id}`}
				className={`viewer-text${isAssociated ? ' viewer-text-associated' : ''}`}
				onClick={() => onSelectTextNode(node.id, parentGroupId)}
				title="Click to highlight associated diffs"
				dangerouslySetInnerHTML={{ __html: rendered }}
			/>
			<button
				type="button"
				className={`viewer-text-comment-trigger${canStartComment ? '' : ' disabled'}`}
				title={triggerTitle}
				disabled={!canStartComment}
				onClick={e => { e.stopPropagation(); if (canStartComment) setComposerOpen(true); }}
			>
				+
			</button>
			{(threads.length > 0 || composerOpen) && (
				<div className="viewer-text-threads" onClick={e => e.stopPropagation()}>
					{threads.map(t => (
						<InlineCommentThread
							key={t.id}
							thread={t}
							onReply={onReplyToThread}
							replyDisabled={!tourCommentsEnabled}
							replyDisabledReason={tourCommentsDisabledReason}
						/>
					))}
					{composerOpen && (
						<InlineCommentComposer
							targetLabel={
								node.sourceStartLine !== undefined && node.sourceEndLine !== undefined
									? node.sourceStartLine === node.sourceEndLine
										? `New thread on this paragraph (line ${node.sourceEndLine})`
										: `New thread on this paragraph (lines ${node.sourceStartLine}-${node.sourceEndLine})`
									: 'New thread on this paragraph'
							}
							onSubmit={handleSubmit}
							onCancel={() => setComposerOpen(false)}
						/>
					)}
				</div>
			)}
		</div>
	);
}
