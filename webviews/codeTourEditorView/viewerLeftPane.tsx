/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as marked from 'marked';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { InlineCommentComposer } from './inlineCommentComposer';
import { InlineCommentThread } from './inlineCommentThread';
import { descendantHunkKeys, EXCLUDED_SECTION_ID, isSectionFullyViewed, isSectionPartiallyViewed } from './viewerModel';
import type { IReviewThread } from '../../src/common/comment';
import { type CodeTourDocument,
	type ExcludedHunkMarker,
	isGlob,
	type TourGroupNode,
	type TourNode,
	type TourTextNode,} from '../../src/github/codeTourMarkdown';
import { Tooltip } from '../common/tooltip';
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
	const { doc, selectedSectionId, onSelectSection } = props;
	const exclusions = doc.exclusions ?? [];
	return (
		<div className="viewer-left">
			<h1 className="viewer-title">{doc.title || 'Untitled Change Tour'}</h1>
			<div className="viewer-left-body">
				{doc.children.map(node => (
					<NodeRenderer key={node.id} node={node} parentGroupId={undefined} {...props} />
				))}
				{exclusions.length > 0 && (
					<ExcludedSectionBlock
						exclusions={exclusions}
						selected={selectedSectionId === EXCLUDED_SECTION_ID}
						onSelectSection={onSelectSection}
					/>
				)}
			</div>
		</div>
	);
}

/**
 * Render the "target" of an exclusion marker in the left-pane outline. Three
 * shapes share the styling but differ in suffix:
 *  - exact-range marker (`file=` literal, `lines="A-B"`): `file:A-B`
 *  - whole-file marker (`file=` literal, no `lines=`): `file (whole file)`
 *  - glob marker (`file=` contains `*`/`?`/`[`, no `lines=`): `file (pattern)`
 */
function renderExclusionTarget(e: ExcludedHunkMarker): React.ReactNode {
	const hasRange = e.startLine !== undefined && e.endLine !== undefined;
	const suffix = hasRange
		? <span className="viewer-excluded-appendix-range">{`:${e.startLine}-${e.endLine}`}</span>
		: <span className="viewer-excluded-appendix-kind"> {isGlob(e.file) ? '(pattern)' : '(whole file)'}</span>;
	return (
		<>
			<span className="viewer-excluded-appendix-file">{e.file}</span>
			{suffix}
		</>
	);
}

/**
 * Synthetic outline entry rendered at the tail of the left pane when the tour
 * carries any `<!-- changetour:exclude ... -->` markers. Clicking the header
 * sets the special `EXCLUDED_SECTION_ID` filter, which the viewer translates
 * into a right-pane view showing only the excluded entries. Click again to
 * clear (matches the toggle behavior of real section headers).
 */
function ExcludedSectionBlock({
	exclusions,
	selected,
	onSelectSection,
}: {
	exclusions: ReadonlyArray<ExcludedHunkMarker>;
	selected: boolean;
	onSelectSection: (id: string) => void;
}) {
	const count = exclusions.length;
	return (
		<div className={`viewer-excluded-appendix${selected ? ' viewer-excluded-appendix-selected' : ''}`}>
			{/*
			 * Styled like a section header (muted text + chevron) rather than a
			 * colored button. Uses a `div[role=button]` instead of `<button>`
			 * so it doesn't inherit the global VS Code button background. The
			 * chevron is open when selected (list shown), closed otherwise.
			 */}
			<Tooltip text={selected ? 'Hide excluded changes' : 'Show PR hunks the author intentionally left out of this tour (deleted files, generated noise, etc.)'}>
				<div
					role="button"
					tabIndex={0}
					className="viewer-excluded-appendix-header"
					onClick={() => onSelectSection(EXCLUDED_SECTION_ID)}
					onKeyDown={e => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							onSelectSection(EXCLUDED_SECTION_ID);
						}
					}}
				>
					<span className={`expand-icon icon-button ${selected ? '' : 'closed'}`}>{chevronDownIcon}</span>
					<span className="viewer-excluded-appendix-header-title">Excluded</span>
					<span className="viewer-excluded-appendix-header-count">({count})</span>
				</div>
			</Tooltip>
			{selected && (
				<ul className="viewer-excluded-appendix-list">
					{exclusions.map((e, i) => (
						<li key={`${e.file}:${e.startLine ?? '*'}-${e.endLine ?? '*'}:${i}`} className="viewer-excluded-appendix-item">
							{renderExclusionTarget(e)}
						</li>
					))}
				</ul>
			)}
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
				<Tooltip text={collapsed ? 'Expand section' : 'Collapse section'}>
					<span
						className={`expand-icon icon-button ${collapsed ? 'closed' : ''}`}
						onClick={e => { e.stopPropagation(); onToggleCollapse(node.id); }}
					>
						{chevronDownIcon}
					</span>
				</Tooltip>
				<Tooltip text={selected ? 'Clear section selection' : 'Show only this section\'s hunks'}>
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
					>
						{node.title || 'Untitled Section'}
					</div>
				</Tooltip>
				{hasDescendantHunks && (
					<Tooltip text={
						fullyViewed
							? 'Unmark all hunks in this section'
							: partiallyViewed
								? 'Mark remaining hunks in this section as viewed'
								: 'Mark all hunks in this section as viewed'
					}>
						<label
							className={`viewer-viewed-checkbox${fullyViewed ? ' is-viewed' : ''}`}
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
					</Tooltip>
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
			<Tooltip text={triggerTitle}>
				<button
					type="button"
					className={`viewer-text-comment-trigger${canStartComment ? '' : ' disabled'}`}
					disabled={!canStartComment}
					onClick={e => { e.stopPropagation(); if (canStartComment) setComposerOpen(true); }}
				>
					+
				</button>
			</Tooltip>
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
