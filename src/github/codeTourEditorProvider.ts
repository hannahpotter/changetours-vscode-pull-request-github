/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as path from 'path';
import * as vscode from 'vscode';
import { createHunkBlock, HunkReference, parseCodeTourMarkdown } from './codeTourMarkdown';
import { PullRequestModel } from './pullRequestModel';
import { RepositoriesManager } from './repositoriesManager';
import { DiffSide } from '../common/comment';
import Logger from '../common/logger';
import { Schemes } from '../common/uri';
import { formatError } from '../common/utils';
import { generateUuid } from '../common/uuid';
import { IRequestMessage, WebviewBase } from '../common/webview';
import { AssistantMode, runAssistant } from '../lm/tourAssistant/orchestrator';


export const CODE_TOUR_EDITOR_VIEW_TYPE = 'codeTourEditor';

export class CodeTourEditorProvider extends WebviewBase implements vscode.CustomTextEditorProvider {

	public static readonly onDidChangeActiveCodeTour = new vscode.EventEmitter<vscode.TextDocument | undefined>();
	public static activeDocumentTracker: vscode.TextDocument | undefined = undefined;

	private static readonly _webviewPanels = new Map<string, vscode.WebviewPanel>();
	private static readonly _editModeByDocument = new Map<string, boolean>();
	// Pre-registered initial mode for a URI; consumed when the webview sends `ready`.
	// Lets commands like "Edit Change Tour" open the file directly in edit mode without
	// the user seeing a view → edit flash.
	private static readonly _pendingInitialMode = new Map<string, 'view' | 'edit'>();
	private _pendingWebviewEdits = new Map<string, number>();
	// Active assistant runs keyed by requestId so the webview's stop button can abort the matching run.
	private _activeAssistantRuns = new Map<string, AbortController>();

	constructor(private readonly _extensionUri: vscode.Uri, private readonly _reposManager: RepositoriesManager, private readonly _extensionContext: vscode.ExtensionContext) {
		super();
	}

	/**
	 * Record the initial mode the next opening of `uri` should use.
	 * Read once when the webview sends its `ready` message, then cleared.
	 */
	public static requestInitialMode(uri: vscode.Uri, mode: 'view' | 'edit'): void {
		CodeTourEditorProvider._pendingInitialMode.set(uri.toString(), mode);
	}

	private static _viewedStateKey(uri: vscode.Uri): string {
		return `changetour.viewed:${uri.toString()}`;
	}

	private static _setEditModeContext(value: boolean): void {
		vscode.commands.executeCommand('setContext', 'changeTourEditMode', value);
	}

	/** Workspace-state key for the user's preferred diff layout. Shared across all tours. */
	private static readonly _diffLayoutStateKey = 'changetour.diffLayout';
	private static _readDiffLayout(ctx: vscode.ExtensionContext): 'inline' | 'sideBySide' {
		const v = ctx.workspaceState.get<string>(CodeTourEditorProvider._diffLayoutStateKey, 'inline');
		return v === 'sideBySide' ? 'sideBySide' : 'inline';
	}

	/**
	 * Snapshot every owner/repo identifier the active PR might be known by so
	 * the webview can match the tour's frontmatter regardless of whether the
	 * tour was authored against the upstream while the local repo tracks a fork
	 * (or vice versa).
	 */
	private static _activePrInfo(activePR: PullRequestModel | undefined) {
		if (!activePR) {
			return undefined;
		}
		return {
			number: activePR.number,
			owner: activePR.remote.owner,
			repo: activePR.remote.repositoryName,
			baseOwner: activePR.base?.owner,
			baseRepo: activePR.base?.name,
			headOwner: activePR.head?.owner,
			headRepo: activePR.head?.name,
		};
	}

	public static toggleEditMode(uri?: vscode.Uri) {
		if (uri) {
			const panel = CodeTourEditorProvider._webviewPanels.get(uri.toString());
			if (panel) {
				panel.webview.postMessage({
					res: { command: 'codeTourEditor.toggleEditMode' }
				});
				return;
			}
		}

		for (const panel of CodeTourEditorProvider._webviewPanels.values()) {
			if (panel.active || panel.visible) {
				panel.webview.postMessage({
					res: { command: 'codeTourEditor.toggleEditMode' }
				});
				return;
			}
		}
	}

	/**
	 * Flip the persisted diff layout (inline ↔ side-by-side) and broadcast the new value
	 * to every open Change Tour panel so the toggle applies everywhere at once.
	 */
	public static toggleDiffLayout(_uri?: vscode.Uri) {
		const provider = CodeTourEditorProvider._instance;
		if (!provider) {
			return;
		}
		const current = CodeTourEditorProvider._readDiffLayout(provider._extensionContext);
		const next = current === 'inline' ? 'sideBySide' : 'inline';
		provider._extensionContext.workspaceState.update(CodeTourEditorProvider._diffLayoutStateKey, next);
		for (const panel of CodeTourEditorProvider._webviewPanels.values()) {
			panel.webview.postMessage({
				res: { command: 'codeTourEditor.updateDiffLayout', diffLayout: next }
			});
		}
	}

	public static toggleChangesForDocument(uri?: vscode.Uri) {
		if (uri) {
			const panel = CodeTourEditorProvider._webviewPanels.get(uri.toString());
			if (panel) {
				panel.webview.postMessage({
					res: { command: 'codeTourEditor.toggleChanges' }
				});
				return;
			}
		}

		for (const panel of CodeTourEditorProvider._webviewPanels.values()) {
			if (panel.active || panel.visible) {
				panel.webview.postMessage({
					res: { command: 'codeTourEditor.toggleChanges' }
				});
				return;
			}
		}
	}

	public static async addHunkToEditor(hunks: HunkReference[], mode: 'active' | 'quickpick') {
		const document = CodeTourEditorProvider.activeDocumentTracker;
		if (!document) {
			vscode.window.showErrorMessage('No active Change Tour editor found. Please focus a Change Tour first.');
			return;
		}

		const uri = document.uri;
		const panel = CodeTourEditorProvider._webviewPanels.get(uri.toString());
		if (!panel) {
			vscode.window.showErrorMessage('No Change Tour editor panel found.');
			return;
		}

		if (mode === 'quickpick') {
			panel.webview.postMessage({ res: { command: 'codeTourEditor.requestGroupsForQuickPick', hunk: hunks } });
		} else {
			panel.webview.postMessage({
				res: {
					command: 'codeTourEditor.insertHunkAt',
					hunk: hunks,
					mode
				}
			});
		}
	}

	public static scrollToNode(uri: vscode.Uri, nodeId: string) {
		const key = uri.toString();
		const panel = CodeTourEditorProvider._webviewPanels.get(key);
		if (panel) {
			if (!panel.active) {
				panel.reveal();
			}
			panel.webview.postMessage({
				res: { command: 'codeTourEditor.scrollToNode', id: nodeId }
			});
		} else {
			vscode.window.showErrorMessage(`No Change Tour editor found for ${key}`);
		}
	}

	private static _instance: CodeTourEditorProvider | undefined;

	public static register(context: vscode.ExtensionContext, reposManager: RepositoriesManager): vscode.Disposable {
		const provider = new CodeTourEditorProvider(context.extensionUri, reposManager, context);
		CodeTourEditorProvider._instance = provider;
		return vscode.window.registerCustomEditorProvider(
			CODE_TOUR_EDITOR_VIEW_TYPE,
			provider,
			{
				webviewOptions: { retainContextWhenHidden: true },
				supportsMultipleEditorsPerDocument: false,
			},
		);
	}

	public async resolveCustomTextEditor(
		document: vscode.TextDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken,
	): Promise<void> {
		// For non-file URIs (VS Code's diff editor, PR review, git history,
		// etc.) the rendered Change Tour view doesn't compose with the diff
		// layout and the user just wants to see the raw markdown change.
		// Dispose this webview and reopen the resource in the default text
		// editor - the diff editor will then show plain text on each side.
		if (document.uri.scheme !== Schemes.File) {
			webviewPanel.dispose();
			await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
			return;
		}

		const key = document.uri.toString();
		CodeTourEditorProvider._webviewPanels.set(key, webviewPanel);

		if (webviewPanel.active) {
			CodeTourEditorProvider.activeDocumentTracker = document;
			CodeTourEditorProvider.onDidChangeActiveCodeTour.fire(document);
			vscode.commands.executeCommand('setContext', 'activeCodeTour', true);
			CodeTourEditorProvider._setEditModeContext(CodeTourEditorProvider._editModeByDocument.get(key) ?? false);
		}

		const viewStateDisposable = webviewPanel.onDidChangeViewState(e => {
			if (e.webviewPanel.active) {
				CodeTourEditorProvider.activeDocumentTracker = document;
				CodeTourEditorProvider.onDidChangeActiveCodeTour.fire(document);
				vscode.commands.executeCommand('setContext', 'activeCodeTour', true);
				CodeTourEditorProvider._setEditModeContext(CodeTourEditorProvider._editModeByDocument.get(key) ?? false);
			} else if (CodeTourEditorProvider.activeDocumentTracker === document) {
				CodeTourEditorProvider.activeDocumentTracker = undefined;
				CodeTourEditorProvider.onDidChangeActiveCodeTour.fire(undefined);
				vscode.commands.executeCommand('setContext', 'activeCodeTour', false);
				CodeTourEditorProvider._setEditModeContext(false);
			}
		});

		this._webview = webviewPanel.webview;

		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'dist')],
		};

		webviewPanel.webview.html = this._getHtmlForWebview(webviewPanel.webview);

		// Listen for webview ready + messages
		const messageDisposable = webviewPanel.webview.onDidReceiveMessage(async (message: IRequestMessage<any>) => {
			await this._handleMessage(document, webviewPanel, message);
		});

		// Sync document → webview when the text document changes (e.g. from undo/redo)
		const changeDisposable = vscode.workspace.onDidChangeTextDocument(e => {
			if (e.document.uri.toString() === document.uri.toString() && e.contentChanges.length > 0) {
				// Skip echo: decrement counter for each webview-originated edit
				const pending = this._pendingWebviewEdits.get(key) ?? 0;
				if (pending > 0) {
					this._pendingWebviewEdits.set(key, pending - 1);
					return;
				}
				this._sendDocumentToWebview(webviewPanel.webview, document);
			}
		});

		const disposables: vscode.Disposable[] = [];
		const folderManager = this._reposManager.getManagerForFile(document.uri) ?? this._reposManager.folderManagers[0];

		const bindActivePRListener = (manager: typeof folderManager) => {
			if (!manager) return;
			disposables.push(manager.onDidChangeActivePullRequest(e => {
				const prInfo = CodeTourEditorProvider._activePrInfo(e.new);
				webviewPanel.webview.postMessage({
					res: {
						command: 'codeTourEditor.updateActivePR',
						activePR: prInfo
					}
				});
			}));
		};

		if (folderManager) {
			bindActivePRListener(folderManager);
		} else {
			// If it hasn't initialized yet, listen for the folder repository to be added
			disposables.push(this._reposManager.onDidChangeFolderRepositories(e => {
				if (e.added) {
					bindActivePRListener(e.added);
					if (e.added.activePullRequest) {
						webviewPanel.webview.postMessage({
							res: {
								command: 'codeTourEditor.updateActivePR',
								activePR: CodeTourEditorProvider._activePrInfo(e.added.activePullRequest)
							}
						});
					}
				}
			}));
		}

		webviewPanel.onDidDispose(() => {
			CodeTourEditorProvider._webviewPanels.delete(key);
			CodeTourEditorProvider._editModeByDocument.delete(key);
			messageDisposable.dispose();
			changeDisposable.dispose();
			viewStateDisposable.dispose();
			if (CodeTourEditorProvider.activeDocumentTracker === document) {
				CodeTourEditorProvider.activeDocumentTracker = undefined;
				CodeTourEditorProvider.onDidChangeActiveCodeTour.fire(undefined);
				vscode.commands.executeCommand('setContext', 'activeCodeTour', false);
				CodeTourEditorProvider._setEditModeContext(false);
			}
			disposables.forEach(d => d.dispose());
		});
	}

	private async _handleMessage(
		document: vscode.TextDocument,
		panel: vscode.WebviewPanel,
		message: IRequestMessage<any>,
	): Promise<void> {
		switch (message.command) {
			case 'ready':
				this._sendDocumentToWebview(panel.webview, document);
				// Kick off the PR data fetch in the background so the outdated-hunk
				// banner can render as soon as it's available. We don't await -
				// the webview renders immediately from the initialize message; the
				// changes data arrives later and triggers re-detection. Failure is
				// silent (no PR resolved, offline, etc.) - the banner just stays
				// hidden in that case.
				this._sendChangesData(document, panel).catch(e =>
					Logger.error(`Failed to fetch PR changes on init: ${formatError(e)}`, CodeTourEditorProvider.name),
				);
				return;

			case 'codeTourEditor.updateDocument': {
				const { markdown } = message.args as { markdown: string };
				await this._applyEdit(document, markdown);
				return;
			}

			case 'codeTourEditor.insertHunk': {
				const { hunk } = message.args as { hunk: HunkReference[] };
				if (hunk.length === 0) {
					return;
				}
				const block = hunk.map(createHunkBlock).join('\n\n');
				const text = document.getText();
				const newText = text.trimEnd() + '\n\n' + block + '\n';
				await this._applyEdit(document, newText);
				return;
			}

			case 'codeTourEditor.openDiff': {
				const { hunk } = message.args as { hunk: HunkReference };
				vscode.commands.executeCommand('codetour.openDiff', hunk);
				return;
			}

			case 'codeTourEditor.showError': {
				const { message: errMsg } = message.args as { message: string };
				vscode.window.showErrorMessage(errMsg);
				return;
			}

			case 'codeTourEditor.checkoutPR': {
				const { prNumber, owner, repo } = message.args as { prNumber: number, owner: string, repo: string };
				vscode.commands.executeCommand('pr.checkoutFromCodeTour', prNumber, owner, repo, document.uri);
				return;
			}

			case 'codeTourEditor.addHunk': {
				const { hunk, mode } = message.args as { hunk: HunkReference[], mode: 'active' | 'quickpick' };
				CodeTourEditorProvider.addHunkToEditor(hunk, mode);
				return;
			}

			case 'codeTourEditor.showGroupsQuickPick': {
				const { groups, hunk } = message.args as { groups: { id: string, title: string, level: number }[], hunk: HunkReference[] };
				const options: ({ label: string, id: string })[] = [
					{ label: '$(root-folder) Document End', id: 'root' },
					...groups.map(g => ({
						label: '\u00A0'.repeat((g.level - 1) * 4) + '$(symbol-folder) ' + (g.title || 'Untitled Section'),
						id: g.id
					}))
				];
				const selected = await vscode.window.showQuickPick(options, { placeHolder: 'Select target section for hunk' });
				if (selected) {
					panel.webview.postMessage({
						res: {
							command: 'codeTourEditor.insertHunkAt',
							hunk,
							mode: 'quickpick',
							targetId: selected.id
						}
					});
				}
				return;
			}

			case 'codeTourEditor.runAssistant': {
				const { mode, hunkId, groupId, requestId } = message.args as {
					mode: 'autoGenerate' | 'narrateHunk' | 'improveSection' | 'summarizeHunk' | 'updateTour' | 'refreshHunkNarration';
					hunkId?: string;
					groupId?: string;
					requestId: string;
				};
				this._runAssistantForWebview(panel, document, mode, requestId, { hunkId, groupId });
				return;
			}

			case 'codeTourEditor.cancelAssistant': {
				const { requestId } = message.args as { requestId: string };
				const controller = this._activeAssistantRuns.get(requestId);
				if (controller) {
					controller.abort();
				}
				return;
			}

			case 'codeTourEditor.setEditMode': {
				const { isEditMode } = message.args as { isEditMode: boolean };
				const docKey = document.uri.toString();
				CodeTourEditorProvider._editModeByDocument.set(docKey, isEditMode);
				if (CodeTourEditorProvider.activeDocumentTracker?.uri.toString() === docKey) {
					CodeTourEditorProvider._setEditModeContext(isEditMode);
				}
				return;
			}

			case 'codeTourViewer.persistViewed': {
				const { keys } = message.args as { keys: string[] };
				const stateKey = CodeTourEditorProvider._viewedStateKey(document.uri);
				if (Array.isArray(keys) && keys.length > 0) {
					await this._extensionContext.workspaceState.update(stateKey, keys);
				} else {
					await this._extensionContext.workspaceState.update(stateKey, undefined);
				}
				return;
			}

			case 'codeTourViewer.loadThreads': {
				const { prNumber, prOwner, prRepo } = message.args as { prNumber: number; prOwner: string; prRepo: string };
				try {
					const folderManager = this._reposManager.getManagerForRepository(prOwner, prRepo);
					if (!folderManager) {
						panel.webview.postMessage({ res: { command: 'codeTourViewer.threadsLoaded', threads: [] } });
						return;
					}
					const pr = await folderManager.resolvePullRequest(prOwner, prRepo, Number(prNumber));
					if (!pr) {
						panel.webview.postMessage({ res: { command: 'codeTourViewer.threadsLoaded', threads: [] } });
						return;
					}
					const threads = await pr.getReviewThreads();
					panel.webview.postMessage({ res: { command: 'codeTourViewer.threadsLoaded', threads } });
				} catch (e) {
					Logger.error(`Failed to load review threads: ${formatError(e)}`, CodeTourEditorProvider.name);
					panel.webview.postMessage({ res: { command: 'codeTourViewer.threadsLoaded', threads: [] } });
				}
				return;
			}

			case 'codeTourViewer.addComment': {
				const { requestId, prNumber, prOwner, prRepo, file, startLine, endLine, side, body } = message.args as {
					requestId: string;
					prNumber: number;
					prOwner: string;
					prRepo: string;
					file: string;
					startLine?: number;
					endLine: number;
					side: 'LEFT' | 'RIGHT';
					body: string;
				};
				try {
					const folderManager = this._reposManager.getManagerForRepository(prOwner, prRepo);
					if (!folderManager) {
						throw new Error('No checked-out repository matches this pull request.');
					}
					const pr = await folderManager.resolvePullRequest(prOwner, prRepo, Number(prNumber));
					if (!pr) {
						throw new Error('Pull request not found.');
					}
					const diffSide = side === 'LEFT' ? DiffSide.LEFT : DiffSide.RIGHT;
					const effectiveStart = startLine ?? endLine;
					const thread = await pr.createReviewThread(body, file, effectiveStart, endLine, diffSide, false);
					if (!thread) {
						throw new Error('Comment creation returned no thread.');
					}
					panel.webview.postMessage({
						res: { command: 'codeTourViewer.commentPosted', requestId, thread },
					});
				} catch (e) {
					Logger.error(`Failed to post review comment: ${formatError(e)}`, CodeTourEditorProvider.name);
					panel.webview.postMessage({
						res: { command: 'codeTourViewer.commentError', requestId, error: formatError(e) },
					});
				}
				return;
			}

			case 'codeTourViewer.replyToThread': {
				const { requestId, prNumber, prOwner, prRepo, threadId, inReplyToCommentNodeId, body } = message.args as {
					requestId: string;
					prNumber: number;
					prOwner: string;
					prRepo: string;
					threadId: string;
					inReplyToCommentNodeId: string;
					body: string;
				};
				try {
					const folderManager = this._reposManager.getManagerForRepository(prOwner, prRepo);
					if (!folderManager) {
						throw new Error('No checked-out repository matches this pull request.');
					}
					const pr = await folderManager.resolvePullRequest(prOwner, prRepo, Number(prNumber));
					if (!pr) {
						throw new Error('Pull request not found.');
					}
					const comment = await pr.createCommentReply(body, inReplyToCommentNodeId, true);
					if (!comment) {
						throw new Error('Reply creation returned no comment.');
					}
					panel.webview.postMessage({
						res: { command: 'codeTourViewer.replyPosted', requestId, threadId, comment },
					});
				} catch (e) {
					Logger.error(`Failed to post reply: ${formatError(e)}`, CodeTourEditorProvider.name);
					panel.webview.postMessage({
						res: { command: 'codeTourViewer.commentError', requestId, error: formatError(e) },
					});
				}
				return;
			}

			case 'codeTourEditor.requestChanges':
				await this._sendChangesData(document, panel);
				return;

			case 'codeTourEditor.openClaudeCodeUpdate':
				// Delegate to the existing Claude CLI bridge so the same skill
				// install + terminal prompt path runs from either the title-menu
				// or the outdated-banner button.
				await vscode.commands.executeCommand('pr.updateTourWithClaudeCode', document.uri);
				return;

			case 'codeTourEditor.openCopilotChatUpdate':
				// Pre-populate the chat panel with `@change-tour /update`. The
				// user reviews and presses enter; the participant runs the
				// `update` AssistantMode against the active tour.
				await vscode.commands.executeCommand('workbench.action.chat.open', { query: '@change-tour /update ' });
				return;

			default:
				return;
		}
	}

	/**
	 * Fetch the bound PR's current diff and post a `changesData` message back
	 * to the webview. Used for two things: the changes-pane file list (drag/drop
	 * authoring) and the outdated-hunk detector (per-file blob SHAs + current
	 * head SHA + per-file patch). The webview parses each file's patch locally
	 * to derive per-file hunks for the auto-update flow.
	 *
	 * Silent on failure (no PR bound, offline, mismatched binding) - the
	 * outdated banner stays hidden in those cases, which is the right thing.
	 */
	private async _sendChangesData(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
		try {
			const parsed = parseCodeTourMarkdown(document.getText());
			if (!parsed.prOwner || !parsed.prRepo || !parsed.prNumber) {
				return;
			}
			const { prOwner, prRepo, prNumber } = parsed;
			const folderManager = this._reposManager.getManagerForRepository(prOwner, prRepo);
			if (!folderManager) {
				return;
			}
			const prModel = await folderManager.resolvePullRequest(prOwner, prRepo, Number(prNumber));
			if (!prModel) {
				return;
			}
			const rawChanges = await prModel.getRawFileChangesInfo();
			const files = rawChanges.map(change => ({
				fileName: change.filename,
				status: change.status,
				additions: change.additions,
				deletions: change.deletions,
				previousFileName: change.previous_filename,
				patch: change.patch,
				// Per-file blob SHA at PR head. Drag/drop carries this into the hunk's
				// `baseBlob` so the outdated-detection flow can compare against the
				// file's current blob.
				blobSha: change.sha,
			}));
			panel.webview.postMessage({
				res: {
					command: 'codeTourEditor.changesData',
					data: {
						title: prModel.title,
						number: prModel.number,
						owner: prOwner,
						repo: prRepo,
						baseSha: prModel.base.sha,
						headSha: prModel.head?.sha,
						files
					}
				}
			});
		} catch (e) {
			Logger.error(`Failed to fetch PR changes: ${formatError(e)}`, CodeTourEditorProvider.name);
		}
	}

	private _sendDocumentToWebview(webview: vscode.Webview, document: vscode.TextDocument): void {
		try {
			const parsed = parseCodeTourMarkdown(document.getText());
			const folderManager = this._reposManager.getManagerForFile(document.uri) ?? this._reposManager.folderManagers[0];
			const prInfo = CodeTourEditorProvider._activePrInfo(folderManager?.activePullRequest);

			// One-shot initial-mode hint from a command (e.g. "Edit Change Tour" → edit).
			const key = document.uri.toString();
			const requestedMode = CodeTourEditorProvider._pendingInitialMode.get(key);
			if (requestedMode !== undefined) {
				CodeTourEditorProvider._pendingInitialMode.delete(key);
			}

			// Persisted "mark-as-viewed" state for this tour. Stored per document URI
			// in workspaceState so checkmarks survive editor close/reopen and restarts.
			const viewedKeys = this._extensionContext.workspaceState.get<string[]>(
				CodeTourEditorProvider._viewedStateKey(document.uri),
				[],
			);

			// Tour file path relative to its repo root, used by the viewer to
			// pair GitHub review threads with paragraphs in the left pane.
			// Try several roots in order: the folder manager for this file, then
			// every other registered folder manager (handles multi-root workspaces
			// where getManagerForFile heuristics fail), then the workspace folder.
			const candidateRoots: vscode.Uri[] = [];
			const seenRoots = new Set<string>();
			const pushRoot = (uri: vscode.Uri | undefined) => {
				if (!uri) return;
				const key = uri.toString();
				if (seenRoots.has(key)) return;
				seenRoots.add(key);
				candidateRoots.push(uri);
			};
			pushRoot(folderManager?.repository.rootUri);
			for (const fm of this._reposManager.folderManagers) {
				pushRoot(fm.repository.rootUri);
			}
			pushRoot(vscode.workspace.getWorkspaceFolder(document.uri)?.uri);

			let tourFilePath: string | undefined;
			for (const root of candidateRoots) {
				if (root.scheme !== document.uri.scheme) {
					continue;
				}
				const rel = path.relative(root.fsPath, document.uri.fsPath);
				if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
					continue;
				}
				tourFilePath = rel.split(path.sep).join('/');
				break;
			}
			Logger.debug(
				`tourFilePath=${tourFilePath ?? '<none>'} docUri=${document.uri.fsPath} tried=${candidateRoots.map(r => r.fsPath).join('|')}`,
				CodeTourEditorProvider.name,
			);

			webview.postMessage({
				res: {
					command: 'codeTourEditor.initialize',
					data: parsed,
					activePR: prInfo,
					initialEditMode: requestedMode === 'edit'
						? true
						: requestedMode === 'view'
							? false
							: undefined,
					viewedKeys,
					tourFilePath,
					diffLayout: CodeTourEditorProvider._readDiffLayout(this._extensionContext),
				},
			});
		} catch (e) {
			Logger.error(`Error parsing change tour document: ${formatError(e)}`, 'CodeTourEditorProvider');
		}
	}

	/**
	 * Runs the Change Tour assistant orchestrator for a webview-initiated request
	 * and pipes events back to the webview so it can render a streaming indicator
	 * and surface errors. Write tools mutate the open document in place; the
	 * webview will re-render via the existing onDidChangeTextDocument flow.
	 */
	private async _runAssistantForWebview(
		panel: vscode.WebviewPanel,
		document: vscode.TextDocument,
		mode: 'autoGenerate' | 'narrateHunk' | 'improveSection' | 'summarizeHunk' | 'updateTour' | 'refreshHunkNarration',
		requestId: string,
		ctx: { hunkId?: string; groupId?: string },
	): Promise<void> {
		const controller = new AbortController();
		this._activeAssistantRuns.set(requestId, controller);

		const send = (event: unknown) => {
			panel.webview.postMessage({
				res: { command: 'codeTourEditor.assistantEvent', requestId, event },
			});
		};

		const assistantMode: AssistantMode = mode === 'narrateHunk'
			? 'narrate'
			: mode === 'improveSection'
				? 'improve'
				: mode === 'summarizeHunk'
					? 'summarizeHunk'
					: mode === 'updateTour'
						? 'update'
						: mode === 'refreshHunkNarration'
							? 'refreshNarration'
							: 'generate';
		const userPrompt = this._buildAssistantPromptForButton(mode, ctx);
		const workspaceRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri;

		try {
			for await (const event of runAssistant(this._extensionContext, {
				mode: assistantMode,
				userPrompt,
				workspaceRoot,
				signal: controller.signal,
			})) {
				send(event);
				if (event.type === 'done') {
					break;
				}
			}
		} catch (err) {
			send({ type: 'done', reason: 'error', error: err instanceof Error ? err.message : String(err) });
		} finally {
			this._activeAssistantRuns.delete(requestId);
		}
	}

	private _buildAssistantPromptForButton(
		mode: 'autoGenerate' | 'narrateHunk' | 'improveSection' | 'summarizeHunk' | 'updateTour' | 'refreshHunkNarration',
		ctx: { hunkId?: string; groupId?: string },
	): string {
		switch (mode) {
			case 'autoGenerate':
				return 'Generate a complete Change Tour for the active pull request, replacing or extending whatever is currently in the document.';
			case 'narrateHunk':
				return `Draft narration for the hunk with id "${ctx.hunkId}" and insert it immediately after that hunk.`;
			case 'improveSection':
				return `Improve the section with id "${ctx.groupId}" - tighten the narration of its children, add highlights to large hunks where useful, and surface obvious gaps. Do not modify nodes outside this section.`;
			case 'summarizeHunk':
				return `Write a one-line natural-language summary for the hunk with id "${ctx.hunkId}" and save it on that hunk via the summary attribute. Do not insert or modify any other nodes.`;
			case 'updateTour':
				return 'Update this Change Tour to match the current PR. START by calling changeTour_getDriftReport - the three lists it returns are the ground truth for what needs to change. Process every entry in `drifted`, `missingInTour`, and `removedFromPR`. After the edits, call changeTour_getDriftReport again to verify all three lists are empty; if not, repeat. Don\'t stop until the verification call returns empty lists.';
			case 'refreshHunkNarration':
				return `The hunk with id "${ctx.hunkId}" was just auto-updated. Refresh the prose adjacent to that hunk - text nodes immediately before or after - so the narration reflects the hunk's new patch content. Do not modify the hunk itself or any other node in the tour.`;
		}
	}

	private async _applyEdit(document: vscode.TextDocument, newContent: string): Promise<void> {
		const key = document.uri.toString();
		this._pendingWebviewEdits.set(key, (this._pendingWebviewEdits.get(key) ?? 0) + 1);
		const edit = new vscode.WorkspaceEdit();
		edit.replace(
			document.uri,
			new vscode.Range(0, 0, document.lineCount, 0),
			newContent,
		);
		await vscode.workspace.applyEdit(edit);
	}

	private _getHtmlForWebview(webview: vscode.Webview): string {
		const nonce = generateUuid();
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview-code-tour-editor.js'),
		);

		return `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; media-src https:; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline' https: data:;">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
	</head>
	<body class="${process.platform}">
		<div id="app"></div>
		<script nonce="${nonce}" src="${scriptUri.toString()}"></script>
	</body>
</html>`;
	}
}
