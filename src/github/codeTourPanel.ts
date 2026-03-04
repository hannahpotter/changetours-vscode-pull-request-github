/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { PullRequestModel } from './pullRequestModel';
import { ChangedFileInfo } from './views';
import Logger from '../common/logger';
import { formatError } from '../common/utils';
import { generateUuid } from '../common/uuid';
import { IRequestMessage, WebviewBase } from '../common/webview';

export const CHANGED_FILES_VIEW_TYPE = 'PullRequestChangedFiles';

export class CodeTourPanel extends WebviewBase {
	public static readonly viewType = CHANGED_FILES_VIEW_TYPE;

	private static _panels: Map<string, CodeTourPanel> = new Map();

	private readonly _panel: vscode.WebviewPanel;
	private _pullRequest: PullRequestModel;

	public static async createOrShow(
		extensionUri: vscode.Uri,
		pullRequest: PullRequestModel,
	) {
		const key = `${pullRequest.remote.owner}/${pullRequest.remote.repositoryName}#${pullRequest.number}`;
		const activeColumn = vscode.window.activeTextEditor
			? vscode.window.activeTextEditor.viewColumn
			: vscode.ViewColumn.One;

		let panel = this._panels.get(key);
		if (panel) {
			panel._panel.reveal(activeColumn);
		} else {
			const title = `Code Tour - PR #${pullRequest.number}`;
			panel = new CodeTourPanel(extensionUri, activeColumn || vscode.ViewColumn.Active, title, pullRequest);
			this._panels.set(key, panel);
		}

		await panel.update();
	}

	private constructor(
		private readonly _extensionUri: vscode.Uri,
		column: vscode.ViewColumn,
		title: string,
		pullRequest: PullRequestModel,
	) {
		super();
		this._pullRequest = pullRequest;

		this._panel = this._register(vscode.window.createWebviewPanel(
			CodeTourPanel.viewType,
			title,
			column,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(_extensionUri, 'dist')],
			},
		));

		this._webview = this._panel.webview;
		this._panel.webview.html = this.getHtmlForWebview();
		super.initialize();

		this._register(this._panel.onDidDispose(() => this.dispose()));
	}

	private async update(): Promise<void> {
		try {
			const rawChanges = await this._pullRequest.getRawFileChangesInfo();
			const files: ChangedFileInfo[] = rawChanges.map(change => ({
				fileName: change.filename,
				status: change.status,
				additions: change.additions,
				deletions: change.deletions,
				previousFileName: change.previous_filename,
			}));

			this._postMessage({
				command: 'pr.changedFiles.initialize',
				data: {
					title: this._pullRequest.title,
					number: this._pullRequest.number,
					files,
				},
			});
		} catch (e) {
			Logger.error(`Error loading changed files: ${formatError(e)}`, 'CodeTourPanel');
			vscode.window.showErrorMessage(`Error loading changed files: ${formatError(e)}`);
		}
	}

	private getHtmlForWebview(): string {
		const nonce = generateUuid();
		const uri = vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview-code-tour.js');

		return `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src vscode-resource: https:; media-src https:; script-src 'nonce-${nonce}'; style-src vscode-resource: 'unsafe-inline' http: https: data:;">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
	</head>
	<body class="${process.platform}">
		<div id=app></div>
		<script nonce="${nonce}" src="${this._webview!.asWebviewUri(uri).toString()}"></script>
	</body>
</html>`;
	}

	private _removeFromPanels(): void {
		const key = `${this._pullRequest.remote.owner}/${this._pullRequest.remote.repositoryName}#${this._pullRequest.number}`;
		CodeTourPanel._panels.delete(key);
	}

	protected override async _onDidReceiveMessage(message: IRequestMessage<any>): Promise<any> {
		const result = await super._onDidReceiveMessage(message);
		if (result !== this.MESSAGE_UNHANDLED) {
			return;
		}
	}

	public override dispose() {
		super.dispose();
		this._removeFromPanels();
		this._webview = undefined;
	}
}
