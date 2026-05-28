/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as marked from 'marked';
import React, { useMemo } from 'react';
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
}: ViewerLeftPaneProps & { node: TourGroupNode }) {
	const collapsed = collapsedSections.has(node.id);
	const selected = selectedSectionId === node.id;
	return (
		<div className={`viewer-section viewer-section-level-${node.level}${selected ? ' viewer-section-selected' : ''}`}>
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
}: ViewerLeftPaneProps & { node: TourTextNode; parentGroupId: string | undefined }) {
	const isAssociated = selectedTextNodeId === node.id;
	const rendered = useMemo(() => marked.parse(node.content) as string, [node.content]);
	return (
		<div
			id={`viewer-text-${node.id}`}
			className={`viewer-text${isAssociated ? ' viewer-text-associated' : ''}`}
			onClick={() => onSelectTextNode(node.id, parentGroupId)}
			title="Click to highlight associated diffs"
			dangerouslySetInnerHTML={{ __html: rendered }}
		/>
	);
}
