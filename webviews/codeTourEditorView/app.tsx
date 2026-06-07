/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { render } from 'react-dom';
import { ChangedFilesOverview } from './changesOverview';
import { CodeTourEditor } from './codeTourEditor';
import { CodeTourViewer, type ViewerInboxMessage } from './codeTourViewer';
import { RateLimitBanner, type RateLimitNotice } from './rateLimitBanner';

import { type PrState } from './viewerModel';
import { type CodeTourDocument, type HunkReference, parseCodeTourMarkdown, type TourNode } from '../../src/github/codeTourMarkdown';
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
	// The diff picker defaults to open: most authoring sessions immediately
	// need to drag hunks in. When the user collapses it (via the command or
	// the in-editor gutter button), we render a thin `<<` gutter on the right
	// edge so the panel is rediscoverable - VS Code's own command palette
	// works too but the gutter is a one-click in-context affordance.
	const [isChangesOpen, setIsChangesOpen] = useState(true);
	const [changesData, setChangesData] = useState<any>(undefined);
	const [activeNodeId, setActiveNodeId] = useState<string | undefined>(undefined);
	const [insertHunkCommand, setInsertHunkCommand] = useState<{ ts: number, payload: HunkReference[], mode: 'active' | 'quickpick' | 'requestGroupsForQuickPick', targetId?: string } | undefined>(undefined);
	const [insertMultipleHunksCommand, setInsertMultipleHunksCommand] = useState<{ ts: number, payloads: HunkReference[] } | undefined>(undefined);
	const [assistantStatus, setAssistantStatus] = useState<{ running: boolean; requestId?: string; label?: string; error?: string }>({ running: false });
	const [viewerInbox, setViewerInbox] = useState<ViewerInboxMessage | undefined>(undefined);
	const [initialViewedKeys, setInitialViewedKeys] = useState<string[]>([]);
	const [tourFilePath, setTourFilePath] = useState<string | undefined>(undefined);
	const [diffLayout, setDiffLayout] = useState<'inline' | 'sideBySide'>('inline');
	// Surfaced when the extension hits a GitHub API rate-limit while loading
	// PR data for this tour. Cleared automatically when the matching retry
	// succeeds (`changesData` for the changes fetch; `threadsLoaded` for the
	// review-threads fetch - both messages only arrive on success now).
	const [rateLimitNotice, setRateLimitNotice] = useState<RateLimitNotice | undefined>(undefined);

	useEffect(() => {
		if (!handler || !doc) {
			return;
		}
		handler.postMessage({
			command: 'codeTourEditor.setEditMode',
			args: { isEditMode },
		});
	}, [handler, doc, isEditMode]);

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
					if (typeof message.tourFilePath === 'string') {
						setTourFilePath(message.tourFilePath);
					} else if (message.tourFilePath === undefined) {
						setTourFilePath(undefined);
					}
					if (message.diffLayout === 'inline' || message.diffLayout === 'sideBySide') {
						setDiffLayout(message.diffLayout);
					}
					return;
				case 'codeTourEditor.updateActivePR':
					setActivePR(message.activePR);
					return;
				case 'codeTourEditor.updateDiffLayout':
					if (message.diffLayout === 'inline' || message.diffLayout === 'sideBySide') {
						setDiffLayout(message.diffLayout);
					}
					return;
				case 'codeTourEditor.toggleEditMode':
					setIsEditMode(prev => !prev);
					return;
				case 'codeTourEditor.scrollToNode':
					setScrollToNode({ id: message.id, ts: Date.now() });
					return;
				case 'codeTourEditor.changesData':
					setChangesData(message.data);
					// A successful changes fetch implicitly clears a "changes"
					// rate-limit banner. If the banner was set for a different
					// retry kind (threads), leave it - the threads load is
					// still failing.
					setRateLimitNotice(prev => prev?.retryKind === 'changes' ? undefined : prev);
					return;
				case 'codeTourEditor.rateLimitHit':
					setRateLimitNotice({
						resetAt: message.resetAt,
						retryKind: message.retryKind,
						message: message.message,
						isSecondary: !!message.isSecondary,
						resource: message.resource,
					});
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
					// Backend only emits this on a successful threads fetch
					// (the rate-limit catch path deliberately skips the empty
					// payload). Use it as the clear signal for a "threads"
					// rate-limit banner.
					setRateLimitNotice(prev => prev?.retryKind === 'threads' ? undefined : prev);
					setViewerInbox({ ts: Date.now(), message });
					return;
				case 'codeTourViewer.retryLoadThreads':
					// Forwarded from the extension after the user clicks Retry
					// on a "threads" rate-limit banner. The viewer handles
					// re-issuing the load since it owns the PR coordinates.
					setViewerInbox({ ts: Date.now(), message });
					return;
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
		// Keep app-level doc in sync with what the editor just synced. Without
		// this, toggling to view mode and back remounts CodeTourEditor with the
		// stale initial parse, losing every local edit the user made (e.g. a
		// fresh paragraph highlight). CodeTourEditor's initialDoc effect
		// recognizes the self-echo via a markdown comparison and skips the
		// override, so local node IDs survive.
		try {
			setDoc(parseCodeTourMarkdown(markdown));
		} catch {
			// ignore parse failures; the host will surface them
		}
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
		if (doc && doc.prNumber !== undefined) {
			payload.prNumber = doc.prNumber;
			payload.prOwner = doc.prOwner;
			payload.prRepo = doc.prRepo;
		}

		handler?.postMessage({
			command: 'codeTourEditor.openDiff',
			args: { hunk: payload },
		});
	}, [handler, doc]);

	const onOpenExcludedDiff = useCallback((hunks: any[], target: string) => {
		// Attach PR coords to every candidate so codetour.openDiff gets the
		// same context the single-hunk path provides. The provider shows a
		// quickpick when there's more than one candidate.
		const payloads = hunks.map(h => {
			const p = { ...h };
			if (doc && doc.prNumber !== undefined) {
				p.prNumber = doc.prNumber;
				p.prOwner = doc.prOwner;
				p.prRepo = doc.prRepo;
			}
			return p;
		});
		handler?.postMessage({
			command: 'codeTourEditor.openExcludedDiff',
			args: { hunks: payloads, target },
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

	const onHunkExclude = useCallback((file: string, startLine: number, endLine: number, fp: string | undefined) => {
		handler?.postMessage({
			command: 'codeTourEditor.excludeHunk',
			args: { file, startLine, endLine, fp }
		});
	}, [handler]);

	const onFileExclude = useCallback((file: string) => {
		handler?.postMessage({
			command: 'codeTourEditor.excludeFile',
			args: { file }
		});
	}, [handler]);

	const onRemoveExclusion = useCallback((file: string, startLine?: number, endLine?: number) => {
		handler?.postMessage({
			command: 'codeTourEditor.removeExclusion',
			args: { file, startLine, endLine }
		});
	}, [handler]);

	// Open the changes pane (no-op if already open). Used by the editor when
	// the user clicks "Add hunk" so the picker appears automatically instead
	// of forcing the user to toggle it separately.
	const onRequestChangesOpen = useCallback(() => {
		setIsChangesOpen(prev => {
			if (prev) {
				return prev;
			}
			if (!changesData) {
				handler?.postMessage({ command: 'codeTourEditor.requestChanges' });
			}
			return true;
		});
	}, [handler, changesData]);

	const [codeTourHunks, setCodeTourHunks] = useState<HunkReference[]>([]);
	const onCodeTourHunksChange = useCallback((hunks: HunkReference[]) => {
		setCodeTourHunks(hunks);
	}, []);

	const onAddAllMissing = useCallback((hunks: HunkReference[]) => {
		setInsertMultipleHunksCommand({ ts: Date.now(), payloads: hunks });
	}, []);

	const onRunAssistant = useCallback((mode: 'autoGenerate' | 'narrateHunk' | 'improveSection' | 'summarizeHunk' | 'updateTour' | 'refreshHunkNarration', ctx?: { hunkId?: string; groupId?: string }) => {
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

	// Slim, detection-oriented view of `changesData`. The outdated-hunk
	// detector and the auto-update flow only need the current head SHA and the
	// per-file blob + patch - not the full changes-pane payload. Passing the
	// smaller shape keeps the viewer / editor decoupled from the changes pane.
	const prState = useMemo<PrState | undefined>(() => {
		if (!changesData) {
			return undefined;
		}
		return {
			currentHeadSha: changesData.headSha,
			files: Array.isArray(changesData.files)
				? changesData.files.map((f: any) => ({
					fileName: f.fileName,
					previousFileName: f.previousFileName,
					patch: f.patch,
					blobSha: f.blobSha,
				}))
				: undefined,
		};
	}, [changesData]);

	// Manual refresh from the outdated banner: re-fetch PR data. The extension
	// reuses `_sendChangesData`, which re-posts `codeTourEditor.changesData`
	// and re-triggers detection downstream.
	const onRefreshPrState = useCallback(() => {
		handler?.postMessage({ command: 'codeTourEditor.requestChanges' });
	}, [handler]);

	// When the active PR becomes available (e.g., user checked out the branch
	// after the tour was already open), re-request the changes data. The
	// extension's initial fetch on `ready` returns early if the folder
	// manager / PR isn't resolved yet, so without this trigger the drift
	// banner only appears after closing and reopening the file. The previous
	// fix in the extension's `onDidChangeActivePullRequest` listener regressed
	// the `isMismatch` clearing somehow; doing the trigger here on the
	// transition undefined → defined keeps the extension plumbing untouched.
	const prevActivePRRef = useRef<typeof activePR>(undefined);
	useEffect(() => {
		const prev = prevActivePRRef.current;
		prevActivePRRef.current = activePR;
		if (!handler) return;
		if (activePR && !prev) {
			handler.postMessage({ command: 'codeTourEditor.requestChanges' });
		}
	}, [activePR, handler]);

	// External-assistant update entry points. Both hand off to the extension,
	// which delegates to `pr.updateTourWithClaudeCode` (terminal) and
	// `workbench.action.chat.open` (Copilot Chat with the @change-tour
	// participant pre-loaded).
	const onUpdateWithClaudeCode = useCallback(() => {
		handler?.postMessage({ command: 'codeTourEditor.openClaudeCodeUpdate' });
	}, [handler]);
	const onUpdateWithCopilotChat = useCallback(() => {
		handler?.postMessage({ command: 'codeTourEditor.openCopilotChatUpdate' });
	}, [handler]);

	// Rate-limit banner callbacks. Retry re-runs only the call that failed
	// (the backend keyed it on `retryKind`); on success the matching response
	// message clears the banner via the handler above. "View log" surfaces the
	// "GitHub Pull Request" output channel where the underlying error landed.
	const onRetryRateLimit = useCallback(() => {
		if (!rateLimitNotice) {
			return;
		}
		handler?.postMessage({
			command: 'codeTourEditor.retryAfterRateLimit',
			args: { retryKind: rateLimitNotice.retryKind },
		});
	}, [handler, rateLimitNotice]);
	const onViewRateLimitLog = useCallback(() => {
		handler?.postMessage({ command: 'codeTourEditor.showOutputChannel' });
	}, [handler]);
	const onDismissRateLimit = useCallback(() => setRateLimitNotice(undefined), []);

	if (!doc) {
		return <div className="loading-indicator">Loading...</div>;
	}

	// Rate-limit banner sits at the very top so it's visible regardless of
	// edit/view mode and regardless of which pane is in focus. Rendered above
	// the existing per-pane warning banners (outdated, AI-review) so multiple
	// banners stack predictably.
	const rateLimitBanner = rateLimitNotice ? (
		<RateLimitBanner
			notice={rateLimitNotice}
			onRetry={onRetryRateLimit}
			onViewLog={onViewRateLimitLog}
			onDismiss={onDismissRateLimit}
		/>
	) : null;

	if (!isEditMode) {
		return (
			<div className="code-tour-app-root">
				{rateLimitBanner}
				<div style={{ display: 'flex', width: '100%', height: '100%' }}>
					<CodeTourViewer
						doc={doc}
						activePR={activePR}
						postMessage={msg => handler?.postMessage(msg) ?? Promise.resolve(undefined)}
						inbox={viewerInbox}
						onOpenDiff={onOpenDiff}
						onCheckoutPR={onCheckoutPR}
						initialViewedKeys={initialViewedKeys}
						persistViewed={keys => { handler?.postMessage({ command: 'codeTourViewer.persistViewed', args: { keys } }); }}
						tourFilePath={tourFilePath}
						diffLayout={diffLayout}
						prState={prState}
						onRefreshPrState={onRefreshPrState}
						changesData={changesData}
					/>
				</div>
			</div>
		);
	}

	return (
		<div className="code-tour-app-root">
			{rateLimitBanner}
			<div style={{ display: 'flex', width: '100%', height: '100%' }}>
				<div style={{ flex: 1, minWidth: 0, height: '100%', overflowY: 'auto', borderRight: '1px solid var(--vscode-panel-border)' }}>
					<CodeTourEditor
					document={doc}
					activePR={activePR}
					isEditMode={isEditMode}
					diffLayout={diffLayout}
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
					onRequestChangesOpen={onRequestChangesOpen}
					onError={onError}
					assistantStatus={assistantStatus}
					onRunAssistant={onRunAssistant}
					onCancelAssistant={onCancelAssistant}
					onDismissAssistantError={onDismissAssistantError}
					prState={prState}
					onRefreshPrState={onRefreshPrState}
					onUpdateWithClaudeCode={onUpdateWithClaudeCode}
					onUpdateWithCopilotChat={onUpdateWithCopilotChat}
					changesData={changesData}
					onRemoveExclusion={onRemoveExclusion}
					onOpenExcludedDiff={onOpenExcludedDiff}
				/>
			</div>
				{isChangesOpen ? (
					<div style={{ display: 'flex', flex: 1, minWidth: 0, height: '100%' }}>
						<div
							role="button"
							tabIndex={0}
							className="changes-gutter changes-gutter-open"
							title="Hide PR change list"
							aria-label="Hide PR change list"
							onClick={() => setIsChangesOpen(false)}
							onKeyDown={e => {
								if (e.key === 'Enter' || e.key === ' ') {
									e.preventDefault();
									setIsChangesOpen(false);
								}
							}}
						>
							<span className="changes-gutter-chevrons" aria-hidden="true">{'>>'}</span>
							<span className="changes-gutter-label" aria-hidden="true">Change List</span>
						</div>
						<div style={{ flex: 1, minWidth: 0, height: '100%', overflowY: 'auto', position: 'relative' }}>
							{changesData ? (
								<ChangedFilesOverview {...changesData} onHunkAdd={onHunkAdd} onHunkExclude={onHunkExclude} onFileExclude={onFileExclude} activeNodeContext={activeNodeContext} codeTourHunks={codeTourHunks} exclusions={doc?.exclusions ?? []} onAddAllMissing={onAddAllMissing} diffLayout={diffLayout} />
							) : (
								<div className="loading-indicator">Loading PR changes...</div>
							)}
						</div>
					</div>
				) : (
					<div
						role="button"
						tabIndex={0}
						className="changes-gutter changes-gutter-collapsed"
						title="Show PR change list"
						aria-label="Show PR change list"
						onClick={() => {
							setIsChangesOpen(true);
							if (!changesData) {
								handler?.postMessage({ command: 'codeTourEditor.requestChanges' });
							}
						}}
						onKeyDown={e => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								setIsChangesOpen(true);
								if (!changesData) {
									handler?.postMessage({ command: 'codeTourEditor.requestChanges' });
								}
							}
						}}
					>
						<span className="changes-gutter-chevrons" aria-hidden="true">{'<<'}</span>
						<span className="changes-gutter-label" aria-hidden="true">Change List</span>
					</div>
				)}
			</div>
		</div>
	);
}
