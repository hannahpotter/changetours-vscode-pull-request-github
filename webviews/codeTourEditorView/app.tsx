/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { render } from 'react-dom';
import { ChangedFilesOverview } from './changesOverview';
import { CodeTourEditor } from './codeTourEditor';

import type { CodeTourDocument, TourNode, HunkReference } from '../../src/github/codeTourMarkdown';
import { getMessageHandler, MessageHandler } from '../common/message';

export function main() {
	render(<Root />, document.getElementById('app'));
}

function Root() {
	const [doc, setDoc] = useState<CodeTourDocument | undefined>(undefined);
	const [activePR, setActivePR] = useState<{ number: number; owner: string; repo: string } | undefined>(undefined);
	const [isEditMode, setIsEditMode] = useState(true);
	const [handler, setHandler] = useState<MessageHandler | undefined>(undefined);
	const [scrollToNode, setScrollToNode] = useState<{ id: string; ts: number } | undefined>(undefined);
	const [isChangesOpen, setIsChangesOpen] = useState(false);
	const [changesData, setChangesData] = useState<any>(undefined);
	const [activeNodeId, setActiveNodeId] = useState<string | undefined>(undefined);
	const [insertHunkCommand, setInsertHunkCommand] = useState<{ ts: number, payload: HunkReference, mode: 'active' | 'quickpick' | 'requestGroupsForQuickPick', targetId?: string } | undefined>(undefined);

	useEffect(() => {
		const h = getMessageHandler((message: any) => {
			switch (message.command) {
				case 'codeTourEditor.initialize':
					setDoc(message.data);
					setActivePR(message.activePR);
					return;
				case 'codeTourEditor.updateActivePR':
					setActivePR(message.activePR);
					return;
				case 'codeTourEditor.toggleEditMode':
					setIsEditMode(prev => !prev);
					return;
				case 'codeTourEditor.scrollToNode':
					setScrollToNode({ id: message.id, ts: Date.now() });
					return;
				case 'codeTourEditor.changesData':
					setChangesData(message.data);
					return;
				case 'codeTourEditor.toggleChanges':
					setIsChangesOpen(prev => {
						const next = !prev;
						if (next && !changesData) {
							h.postMessage({ command: 'codeTourEditor.requestChanges' });
						}
						return next;
					});
					return;
				case 'codeTourEditor.insertHunkAt':
					setInsertHunkCommand({ ts: Date.now(), payload: message.hunk, mode: message.mode, targetId: message.targetId });
					return;
				case 'codeTourEditor.requestGroupsForQuickPick':
					setInsertHunkCommand({ ts: Date.now(), payload: message.hunk, mode: 'quickpick' });
					return;
			}
		});
		setHandler(h);
		h.postMessage({ command: 'ready' });
	}, []);

	const onDocumentChange = useCallback((markdown: string) => {
		handler?.postMessage({
			command: 'codeTourEditor.updateDocument',
			args: { markdown },
		});
	}, [handler]);

	const onInsertHunk = useCallback((hunk: any) => {
		handler?.postMessage({
			command: 'codeTourEditor.insertHunk',
			args: { hunk },
		});
	}, [handler]);

	const onOpenDiff = useCallback((hunk: any) => {
		// Attach document PR properties to the hunk payload so the backend command has context
		const payload = { ...hunk };
		if (doc && doc.isPR !== undefined) {
			payload.isPR = doc.isPR;
			payload.prNumber = doc.prNumber;
			payload.prOwner = doc.prOwner;
			payload.prRepo = doc.prRepo;
			payload.baseRef = doc.baseRef;
		}

		handler?.postMessage({
			command: 'codeTourEditor.openDiff',
			args: { hunk: payload },
		});
	}, [handler, doc]);

	const onCheckoutPR = useCallback(() => {
		if (doc && doc.prNumber) {
			handler?.postMessage({
				command: 'codeTourEditor.checkoutPR',
				args: { prNumber: doc.prNumber, owner: doc.prOwner, repo: doc.prRepo }
			});
		}
	}, [handler, doc]);

	const onError = useCallback((message: string) => {
		handler?.postMessage({
			command: 'codeTourEditor.showError',
			args: { message },
		});
	}, [handler]);

	const onActiveNodeChanged = useCallback((nodeId: string | undefined) => {
		setActiveNodeId(nodeId);
		handler?.postMessage({
			command: 'codeTourEditor.setActiveNode',
			args: { nodeId }
		});
	}, [handler]);

	const onProvideGroupsForQuickPick = useCallback((groups: any[], hunk: any) => {
		handler?.postMessage({
			command: 'codeTourEditor.showGroupsQuickPick',
			args: { groups, hunk }
		});
	}, [handler]);

	const activeNodeContext = useMemo(() => {
		if (!doc || !activeNodeId) return undefined;

		function findNode(nodes: TourNode[]): TourNode | undefined {
			for (const node of nodes) {
				if (node.id === activeNodeId) return node;
				if (node.type === 'group' && node.children) {
					const found = findNode(node.children);
					if (found) return found;
				}
			}
			return undefined;
		}

		const activeNode = findNode(doc.children);
		if (!activeNode) return undefined;

		switch (activeNode.type) {
			case 'group':
				return `"${activeNode.title}"`;
			case 'text':
				// Extract a little bit of the content
				const txt = activeNode.content.trim().replace(/\n/g, ' ');
				return txt.length > 25 ? `"${txt.slice(0, 25)}..."` : `"${txt}"`;
			case 'hunk':
				return `Code chunk in ${activeNode.hunk.file.split(/[\\/]/).pop()}`;
		}
	}, [doc, activeNodeId]);

	const onHunkAdd = useCallback((hunk: any, mode: 'active' | 'quickpick') => {
		handler?.postMessage({
			command: 'codeTourEditor.addHunk',
			args: { hunk, mode }
		});
	}, [handler]);

	if (!doc) {
		return <div className="loading-indicator">Loading...</div>;
	}

	return (
		<div style={{ display: 'flex', width: '100%', height: '100%' }}>
			<div style={{ flex: 1, minWidth: 0, height: '100%', overflowY: 'auto', borderRight: isChangesOpen ? '1px solid var(--vscode-panel-border)' : 'none' }}>
				<CodeTourEditor
					document={doc}
					activePR={activePR}
					isEditMode={isEditMode}
					scrollToNode={scrollToNode}
					insertHunkCommand={insertHunkCommand}
					onProvideGroupsForQuickPick={onProvideGroupsForQuickPick}
					onActiveNodeChanged={onActiveNodeChanged}
					onDocumentChange={onDocumentChange}
					onInsertHunk={onInsertHunk}
					onOpenDiff={onOpenDiff}
					onCheckoutPR={onCheckoutPR}
					onError={onError}
				/>
			</div>
			{isChangesOpen && (
				<div style={{ flex: 1, minWidth: 0, height: '100%', overflowY: 'auto', position: 'relative' }}>
					{changesData ? (
						<ChangedFilesOverview {...changesData} onHunkAdd={onHunkAdd} activeNodeContext={activeNodeContext} />
					) : (
						<div className="loading-indicator">Loading PR changes...</div>
					)}
				</div>
			)}
		</div>
	);
}
