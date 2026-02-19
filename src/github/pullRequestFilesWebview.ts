/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import Logger from '../common/logger';
import { formatError } from '../common/utils';
import { IRawFileChange } from './interface';
import { PullRequestModel } from './pullRequestModel';

const VIEW_TYPE = 'PullRequestChangedFiles';

function panelKey(owner: string, repo: string, number: number): string {
	return `${owner}/${repo}#${number}`;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function formatFileLabel(file: IRawFileChange): string {
	if (file.status === 'renamed' && file.previous_filename) {
		return `${file.previous_filename} -> ${file.filename}`;
	}
	return file.filename;
}

export class PullRequestFilesWebviewPanel {
	private static readonly panels: Map<string, PullRequestFilesWebviewPanel> = new Map();

	private _panel: vscode.WebviewPanel;
	private _item: PullRequestModel;

	public static async createOrShow(
		pullRequestModel: PullRequestModel,
	) {
		const activeColumn = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
		const key = panelKey(pullRequestModel.remote.owner, pullRequestModel.remote.repositoryName, pullRequestModel.number);
		let panel = this.panels.get(key);
		if (panel) {
			panel._panel.reveal(activeColumn, true);
		} else {
			panel = new PullRequestFilesWebviewPanel(pullRequestModel, activeColumn);
			this.panels.set(key, panel);
		}
		await panel.update(pullRequestModel);
	}

	private constructor(
		pullRequestModel: PullRequestModel,
		column: vscode.ViewColumn,
	) {
		this._item = pullRequestModel;
		this._panel = vscode.window.createWebviewPanel(
			VIEW_TYPE,
			vscode.l10n.t('Changed Files - Pull Request #{0}', pullRequestModel.number.toString()),
			column,
			{
				enableFindWidget: true,
				enableScripts: false,
				retainContextWhenHidden: true,
			}
		);

		this._panel.onDidDispose(() => {
			const key = panelKey(pullRequestModel.remote.owner, pullRequestModel.remote.repositoryName, pullRequestModel.number);
			PullRequestFilesWebviewPanel.panels.delete(key);
		});
	}

	private async update(pullRequestModel: PullRequestModel): Promise<void> {
		this._item = pullRequestModel;
		this._panel.title = vscode.l10n.t('Changed Files - Pull Request #{0}', pullRequestModel.number.toString());
		this._panel.webview.html = this.getLoadingHtml();

		try {
			const files = await pullRequestModel.getRawFileChangesInfo();
			this._panel.webview.html = this.getHtmlForWebview(files);
		} catch (error) {
			Logger.error(`Failed to load changed files for PR #${pullRequestModel.number}: ${formatError(error)}`, VIEW_TYPE);
			this._panel.webview.html = this.getErrorHtml(formatError(error));
		}
	}

	private getLoadingHtml(): string {
		return `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<title>${vscode.l10n.t('Changed Files')}</title>
		<style>
			body {
				color: var(--vscode-foreground);
				background-color: var(--vscode-editor-background);
				font-family: var(--vscode-font-family);
				padding: 16px;
			}
		</style>
	</head>
	<body>
		<div>${vscode.l10n.t('Loading changed files...')}</div>
	</body>
</html>`;
	}

	private getErrorHtml(message: string): string {
		return `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<title>${vscode.l10n.t('Changed Files')}</title>
		<style>
			body {
				color: var(--vscode-foreground);
				background-color: var(--vscode-editor-background);
				font-family: var(--vscode-font-family);
				padding: 16px;
			}
			.error {
				color: var(--vscode-errorForeground);
			}
		</style>
	</head>
	<body>
		<div class="error">${escapeHtml(message)}</div>
	</body>
</html>`;
	}

	private getHtmlForWebview(files: IRawFileChange[]): string {
		const totals = files.reduce(
			(acc, file) => {
				acc.additions += file.additions;
				acc.deletions += file.deletions;
				return acc;
			},
			{ additions: 0, deletions: 0 },
		);

		const rows = files
			.map(file => {
				const fileLabel = escapeHtml(formatFileLabel(file));
				const status = escapeHtml(file.status.toUpperCase());
				return `<tr>
					<td class="file">${fileLabel}</td>
					<td class="status status-${file.status}">${status}</td>
					<td class="count">+${file.additions}</td>
					<td class="count">-${file.deletions}</td>
				</tr>`;
			})
			.join('');

		const totalText = vscode.l10n.t('{0} files changed', files.length.toString());
		const diffText = vscode.l10n.t('+{0} -{1}', totals.additions.toString(), totals.deletions.toString());

		return `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<title>${vscode.l10n.t('Changed Files')}</title>
		<style>
			:root {
				color-scheme: light dark;
			}
			body {
				color: var(--vscode-foreground);
				background-color: var(--vscode-editor-background);
				font-family: var(--vscode-font-family);
				padding: 16px;
			}
			h1 {
				font-size: 16px;
				margin: 0 0 8px;
			}
			.summary {
				color: var(--vscode-descriptionForeground);
				margin-bottom: 12px;
				font-size: 12px;
			}
			table {
				width: 100%;
				border-collapse: collapse;
			}
			th,
			td {
				text-align: left;
				padding: 6px 8px;
				border-bottom: 1px solid var(--vscode-editorWidget-border);
				font-size: 12px;
			}
			th {
				font-weight: 600;
			}
			.file {
				font-family: var(--vscode-editor-font-family);
			}
			.count {
				white-space: nowrap;
			}
			.status-added,
			.status-copied {
				color: var(--vscode-gitDecoration-addedResourceForeground);
			}
			.status-removed {
				color: var(--vscode-gitDecoration-deletedResourceForeground);
			}
			.status-modified,
			.status-changed {
				color: var(--vscode-gitDecoration-modifiedResourceForeground);
			}
			.status-renamed {
				color: var(--vscode-gitDecoration-renamedResourceForeground);
			}
		</style>
	</head>
	<body>
		<h1>${vscode.l10n.t('Changed Files')}</h1>
		<div class="summary">${escapeHtml(totalText)} &nbsp; ${escapeHtml(diffText)}</div>
		<table aria-label="${vscode.l10n.t('Changed files')}" role="table">
			<thead>
				<tr>
					<th scope="col">${vscode.l10n.t('File')}</th>
					<th scope="col">${vscode.l10n.t('Status')}</th>
					<th scope="col">${vscode.l10n.t('Added')}</th>
					<th scope="col">${vscode.l10n.t('Removed')}</th>
				</tr>
			</thead>
			<tbody>
				${rows || `<tr><td colspan="4">${vscode.l10n.t('No changed files found.')}</td></tr>`}
			</tbody>
		</table>
	</body>
</html>`;
	}
}
