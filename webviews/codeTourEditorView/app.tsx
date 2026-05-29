/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { render } from 'react-dom';
import { ChangedFilesOverview } from './changesOverview';
import { CodeTourEditor } from './codeTourEditor';
import { CodeTourViewer, type ViewerInboxMessage } from './codeTourViewer';

import type { CodeTourDocument, HunkReference, TourNode } from '../../src/github/codeTourMarkdown';
import { getMessageHandler, MessageHandler } from '../common/message';

export function main() {
	render(<Root />, document.getElementById('app'));
}

function toolCallLabel(name: string, input: any): string {
	switch (name) {
		case 'changeTour_getCurrentTour': return 'Reading current tour…';
		case 'changeTour_getAvailablePRHunks': return 'Reading PR hunks…';
		case 'changeTour_addSectionToTour': return `Adding section "${input?.title ?? ''}"…`;
		case 'changeTour_addTextNodeToTour': return 'Adding narration…';
		case 'changeTour_addHunkToTour': return `Adding hunk ${input?.file ?? '?'}:${input?.startLine ?? '?'}-${input?.endLine ?? '?'}…`;
		case 'changeTour_setHunkHighlights': return 'Updating highlights…';
		case 'changeTour_removeTourNode': return 'Removing node…';
		default: return name;
	}
}

function Root() {
	const [doc, setDoc] = useState<CodeTourDocument | undefined>(undefined);
	const [activePR, setActivePR] = useState<{ number: number; owner: string; repo: string } | undefined>(undefined);
	const [isEditMode, setIsEditMode] = useState(false);
	const [handler, setHandler] = useState<MessageHandler | undefined>(undefined);
	const [scrollToNode, setScrollToNode] = useState<{ id: string; ts: number } | undefined>(undefined);
	const [isChangesOpen, setIsChangesOpen] = useState(false);
	const [changesData, setChangesData] = useState<any>(undefined);
	const [activeNodeId, setActiveNodeId] = useState<string | undefined>(undefined);
	const [insertHunkCommand, setInsertHunkCommand] = useState<{ ts: number, payload: HunkReference[], mode: 'active' | 'quickpick' | 'requestGroupsForQuickPick', targetId?: string } | undefined>(undefined);
	const [insertMultipleHunksCommand, setInsertMultipleHunksCommand] = useState<{ ts: number, payloads: HunkReference[] } | undefined>(undefined);
	const [assistantStatus, setAssistantStatus] = useState<{ running: boolean; requestId?: string; label?: string; error?: string }>({ running: false });
	const [viewerInbox, setViewerInbox] = useState<ViewerInboxMessage | undefined>(undefined);
	const [initialViewedKeys, setInitialViewedKeys] = useState<string[]>([]);

	useEffect(() => {
		const h = getMessageHandler((message: any) => {
			switch (message.command) {
				case 'codeTourEditor.initialize':
					setDoc(message.data);
					setActivePR(message.activePR);
					if (message.initialEditMode !== undefined) {
						setIsEditMode(!!message.initialEditMode);
					}
					if (Array.isArray(message.viewedKeys)) {
						setInitialViewedKeys(message.viewedKeys);
					}
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
				case 'codeTourViewer.threadsLoaded':
				case 'codeTourViewer.commentPosted':
				case 'codeTourViewer.replyPosted':
				case 'codeTourViewer.commentError':
					setViewerInbox({ ts: Date.now(), message });
					return;
				case 'codeTourEditor.assistantEvent': {
					const ev = message.event;
					const reqId = message.requestId;
					setAssistantStatus(prev => {
						// Ignore stale events from a previous request.
						if (prev.requestId && prev.requestId !== reqId) {
							return prev;
						}
						if (ev.type === 'started') {
							return { running: true, requestId: reqId, label: `Using ${ev.providerLabel}…` };
						}
						if (ev.type === 'tool_call') {
							return { ...prev, running: true, requestId: reqId, label: toolCallLabel(ev.name, ev.input) };
						}
						if (ev.type === 'text') {
							return { ...prev, running: true, requestId: reqId };
						}
						if (ev.type === 'done') {
							if (ev.reason === 'error') {
								return { running: false, error: ev.error };
							}
							return { running: false };
						}
						return prev;
					});
					return;
				}
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

	const onInsertHunk = useCallback((hunks: HunkReference[]) => {
		handler?.postMessage({
			command: 'codeTourEditor.insertHunk',
			args: { hunk: hunks },
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

	const onProvideGroupsForQuickPick = useCallback((groups: any[], hunks: HunkReference[]) => {
		handler?.postMessage({
			command: 'codeTourEditor.showGroupsQuickPick',
			args: { groups, hunk: hunks }
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

	const onHunkAdd = useCallback((hunks: HunkReference[], mode: 'active' | 'quickpick') => {
		handler?.postMessage({
			command: 'codeTourEditor.addHunk',
			args: { hunk: hunks, mode }
		});
	}, [handler]);

	const [codeTourHunks, setCodeTourHunks] = useState<HunkReference[]>([]);
	const onCodeTourHunksChange = useCallback((hunks: HunkReference[]) => {
		setCodeTourHunks(hunks);
	}, []);

	const onAddAllMissing = useCallback((hunks: HunkReference[]) => {
		setInsertMultipleHunksCommand({ ts: Date.now(), payloads: hunks });
	}, []);

	const onRunAssistant = useCallback((mode: 'autoGenerate' | 'narrateHunk' | 'improveSection', ctx?: { hunkId?: string; groupId?: string }) => {
		if (!handler || assistantStatus.running) {
			return;
		}
		const requestId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		setAssistantStatus({ running: true, requestId, label: 'Starting…' });
		handler.postMessage({
			command: 'codeTourEditor.runAssistant',
			args: { mode, hunkId: ctx?.hunkId, groupId: ctx?.groupId, requestId },
		});
	}, [handler, assistantStatus.running]);

	const onCancelAssistant = useCallback(() => {
		if (!handler || !assistantStatus.running || !assistantStatus.requestId) {
			return;
		}
		handler.postMessage({
			command: 'codeTourEditor.cancelAssistant',
			args: { requestId: assistantStatus.requestId },
		});
	}, [handler, assistantStatus.running, assistantStatus.requestId]);

	const onDismissAssistantError = useCallback(() => {
		setAssistantStatus(prev => ({ ...prev, error: undefined }));
	}, []);

	if (!doc) {
		return <div className="loading-indicator">Loading...</div>;
	}

	if (!isEditMode) {
		return (
			<div style={{ display: 'flex', width: '100%', height: '100%' }}>
				<CodeTourViewer
					doc={doc}
					activePR={activePR}
					postMessage={msg => handler?.postMessage(msg) ?? Promise.resolve(undefined)}
					inbox={viewerInbox}
					onOpenDiff={onOpenDiff}
					initialViewedKeys={initialViewedKeys}
					persistViewed={keys => { handler?.postMessage({ command: 'codeTourViewer.persistViewed', args: { keys } }); }}
				/>
			</div>
		);
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
					insertMultipleHunksCommand={insertMultipleHunksCommand}
					onProvideGroupsForQuickPick={onProvideGroupsForQuickPick}
					onActiveNodeChanged={onActiveNodeChanged}
					onDocumentChange={onDocumentChange}
					onCodeTourHunksChange={onCodeTourHunksChange}
					onInsertHunk={onInsertHunk}
					onOpenDiff={onOpenDiff}
					onCheckoutPR={onCheckoutPR}
					onError={onError}
					assistantStatus={assistantStatus}
					onRunAssistant={onRunAssistant}
					onCancelAssistant={onCancelAssistant}
					onDismissAssistantError={onDismissAssistantError}
				/>
			</div>
			{isChangesOpen && (
				<div style={{ flex: 1, minWidth: 0, height: '100%', overflowY: 'auto', position: 'relative' }}>
					{changesData ? (
						<ChangedFilesOverview {...changesData} onHunkAdd={onHunkAdd} activeNodeContext={activeNodeContext} codeTourHunks={codeTourHunks} onAddAllMissing={onAddAllMissing} />
					) : (
						<div className="loading-indicator">Loading PR changes...</div>
					)}
				</div>
			)}
		</div>
	);
}
