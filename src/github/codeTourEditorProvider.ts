/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { createHunkDirective, HunkReference, parseCodeTourMarkdown } from './codeTourMarkdown';
import { RepositoriesManager } from './repositoriesManager';
import Logger from '../common/logger';
import { formatError } from '../common/utils';
import { generateUuid } from '../common/uuid';
import { IRequestMessage, WebviewBase } from '../common/webview';


export const CODE_TOUR_EDITOR_VIEW_TYPE = 'codeTourEditor';

export class CodeTourEditorProvider extends WebviewBase implements vscode.CustomTextEditorProvider {

	public static readonly onDidChangeActiveCodeTour = new vscode.EventEmitter<vscode.TextDocument | undefined>();
	public static activeDocumentTracker: vscode.TextDocument | undefined = undefined;

	private static readonly _webviewPanels = new Map<string, vscode.WebviewPanel>();
	private _pendingWebviewEdits = new Map<string, number>();

	constructor(private readonly _extensionUri: vscode.Uri, private readonly _reposManager: RepositoriesManager) {
		super();
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
			vscode.window.showErrorMessage('No active Code Tour editor found. Please focus a Code Tour first.');
			return;
		}

		const uri = document.uri;
		const panel = CodeTourEditorProvider._webviewPanels.get(uri.toString());
		if (!panel) {
			vscode.window.showErrorMessage('No Code Tour editor panel found.');
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
			vscode.window.showErrorMessage(`No Code Tour editor found for ${key}`);
		}
	}

	public static register(context: vscode.ExtensionContext, reposManager: RepositoriesManager): vscode.Disposable {
		const provider = new CodeTourEditorProvider(context.extensionUri, reposManager);
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
		const key = document.uri.toString();
		CodeTourEditorProvider._webviewPanels.set(key, webviewPanel);

		if (webviewPanel.active) {
			CodeTourEditorProvider.activeDocumentTracker = document;
			CodeTourEditorProvider.onDidChangeActiveCodeTour.fire(document);
			vscode.commands.executeCommand('setContext', 'activeCodeTour', true);
		}

		const viewStateDisposable = webviewPanel.onDidChangeViewState(e => {
			if (e.webviewPanel.active) {
				CodeTourEditorProvider.activeDocumentTracker = document;
				CodeTourEditorProvider.onDidChangeActiveCodeTour.fire(document);
				vscode.commands.executeCommand('setContext', 'activeCodeTour', true);
			} else if (CodeTourEditorProvider.activeDocumentTracker === document) {
				CodeTourEditorProvider.activeDocumentTracker = undefined;
				CodeTourEditorProvider.onDidChangeActiveCodeTour.fire(undefined);
				vscode.commands.executeCommand('setContext', 'activeCodeTour', false);
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
				const activePR = e.new;
				const prInfo = activePR ? {
					number: activePR.number,
					owner: activePR.remote.owner,
					repo: activePR.remote.repositoryName
				} : undefined;

				console.log('Sending codeTourEditor.updateActivePR with:', prInfo);

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
					// Check if there's already an active PR upon adding
					if (e.added.activePullRequest) {
						const activePR = e.added.activePullRequest;
						webviewPanel.webview.postMessage({
							res: {
								command: 'codeTourEditor.updateActivePR',
								activePR: {
									number: activePR.number,
									owner: activePR.remote.owner,
									repo: activePR.remote.repositoryName
								}
							}
						});
					}
				}
			}));
		}

		webviewPanel.onDidDispose(() => {
			CodeTourEditorProvider._webviewPanels.delete(key);
			messageDisposable.dispose();
			changeDisposable.dispose();
			viewStateDisposable.dispose();
			if (CodeTourEditorProvider.activeDocumentTracker === document) {
				CodeTourEditorProvider.activeDocumentTracker = undefined;
				CodeTourEditorProvider.onDidChangeActiveCodeTour.fire(undefined);
				vscode.commands.executeCommand('setContext', 'activeCodeTour', false);
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
				const directive = hunk.map(createHunkDirective).join('\n\n');
				const text = document.getText();
				const newText = text.trimEnd() + '\n\n' + directive + '\n';
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

			case 'codeTourEditor.requestChanges': {
				try {
					const parsed = parseCodeTourMarkdown(document.getText());
					if (parsed.isPR && parsed.prOwner && parsed.prRepo && parsed.prNumber) {
						const { prOwner, prRepo, prNumber } = parsed;
						const folderManager = this._reposManager.getManagerForRepository(prOwner, prRepo);
						if (folderManager) {
							const prModel = await folderManager.resolvePullRequest(prOwner, prRepo, Number(prNumber));
							if (prModel) {
								const rawChanges = await prModel.getRawFileChangesInfo();
								const files = rawChanges.map(change => ({
									fileName: change.filename,
									status: change.status,
									additions: change.additions,
									deletions: change.deletions,
									previousFileName: change.previous_filename,
									patch: change.patch,
								}));
								panel.webview.postMessage({
									res: {
										command: 'codeTourEditor.changesData',
										data: {
											title: prModel.title,
											number: prModel.number,
											owner: prOwner,
											repo: prRepo,
											baseRef: prModel.base.sha,
											files
										}
									}
								});
							}
						}
					}
				} catch (e) {
					Logger.error(`Failed to fetch PR changes: ${formatError(e)}`, CodeTourEditorProvider.name);
				}
				return;
			}

			default:
				return;
		}
	}

	private _sendDocumentToWebview(webview: vscode.Webview, document: vscode.TextDocument): void {
		try {
			const parsed = parseCodeTourMarkdown(document.getText());
			const folderManager = this._reposManager.getManagerForFile(document.uri) ?? this._reposManager.folderManagers[0];
			const activePR = folderManager?.activePullRequest;
			const prInfo = activePR ? {
				number: activePR.number,
				owner: activePR.remote.owner,
				repo: activePR.remote.repositoryName
			} : undefined;

			webview.postMessage({
				res: {
					command: 'codeTourEditor.initialize',
					data: parsed,
					activePR: prInfo
				},
			});
		} catch (e) {
			Logger.error(`Error parsing code tour document: ${formatError(e)}`, 'CodeTourEditorProvider');
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
