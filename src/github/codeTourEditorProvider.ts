/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
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

	private static readonly _webviewPanels = new Map<string, vscode.WebviewPanel>();
	private _pendingWebviewEdits = new Map<string, number>();

	constructor(private readonly _extensionUri: vscode.Uri, private readonly _reposManager: RepositoriesManager) {
		super();
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

		let prChangeDisposable: vscode.Disposable | undefined;
		const folderManager = this._reposManager.folderManagers[0];
		if (folderManager) {
			prChangeDisposable = folderManager.onDidChangeActivePullRequest(e => {
				const activePR = e.new;
				const prInfo = activePR ? {
					number: activePR.number,
					owner: activePR.remote.owner,
					repo: activePR.remote.repositoryName
				} : undefined;
				webviewPanel.webview.postMessage({
					res: {
						command: 'codeTourEditor.updateActivePR',
						activePR: prInfo
					}
				});
			});
		}

		webviewPanel.onDidDispose(() => {
			CodeTourEditorProvider._webviewPanels.delete(key);
			messageDisposable.dispose();
			changeDisposable.dispose();
			prChangeDisposable?.dispose();
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
				const { hunk } = message.args as { hunk: HunkReference };
				const directive = createHunkDirective(hunk);
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

			default:
				return;
		}
	}

	private _sendDocumentToWebview(webview: vscode.Webview, document: vscode.TextDocument): void {
		try {
			const parsed = parseCodeTourMarkdown(document.getText());
			const activePR = this._reposManager.folderManagers[0]?.activePullRequest;
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
