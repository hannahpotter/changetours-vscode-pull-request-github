/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import Logger from '../common/logger';
import { formatError } from '../common/utils';
import { generateUuid } from '../common/uuid';
import { FolderRepositoryManager } from './folderRepositoryManager';
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

function serializeForScript<T>(value: T): string {
	return JSON.stringify(value).replace(/</g, '\\u003c');
}

export class PullRequestFilesWebviewPanel {
	private static readonly panels: Map<string, PullRequestFilesWebviewPanel> = new Map();

	private _panel: vscode.WebviewPanel;
	private _item: PullRequestModel;
	private _folderRepositoryManager: FolderRepositoryManager;

	public static async createOrShow(
		folderRepositoryManager: FolderRepositoryManager,
		pullRequestModel: PullRequestModel,
	) {
		const activeColumn = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
		const key = panelKey(pullRequestModel.remote.owner, pullRequestModel.remote.repositoryName, pullRequestModel.number);
		let panel = this.panels.get(key);
		if (panel) {
			panel._panel.reveal(activeColumn, true);
		} else {
			panel = new PullRequestFilesWebviewPanel(folderRepositoryManager, pullRequestModel, activeColumn);
			this.panels.set(key, panel);
		}
		await panel.update(pullRequestModel);
	}

	private constructor(
		folderRepositoryManager: FolderRepositoryManager,
		pullRequestModel: PullRequestModel,
		column: vscode.ViewColumn,
	) {
		this._item = pullRequestModel;
		this._folderRepositoryManager = folderRepositoryManager;
		this._panel = vscode.window.createWebviewPanel(
			VIEW_TYPE,
			vscode.l10n.t('Changed Files - Pull Request #{0}', pullRequestModel.number.toString()),
			column,
			{
				enableFindWidget: true,
				enableScripts: true,
				retainContextWhenHidden: true,
			}
		);

		this._panel.onDidDispose(() => {
			const key = panelKey(pullRequestModel.remote.owner, pullRequestModel.remote.repositoryName, pullRequestModel.number);
			PullRequestFilesWebviewPanel.panels.delete(key);
		});

		this._panel.webview.onDidReceiveMessage(async message => {
			if (!message || message.command !== 'openGroupChanges') {
				return;
			}
			const fileNames = Array.isArray(message.fileNames) ? message.fileNames : [];
			const groupName = typeof message.groupName === 'string' ? message.groupName : undefined;
			await this.openGroupChanges(fileNames, groupName);
		});
	}

	private async openGroupChanges(fileNames: string[], groupName?: string): Promise<void> {
		if (!fileNames.length) {
			await vscode.window.showInformationMessage(vscode.l10n.t('No files in this group to open.'));
			return;
		}
		const changeModels = await PullRequestModel.getChangeModels(this._folderRepositoryManager, this._item);
		const fileNameSet = new Set(fileNames);
		const args: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][] = [];
		for (const changeModel of changeModels) {
			if (fileNameSet.has(changeModel.fileName)) {
				args.push([changeModel.filePath, changeModel.parentFilePath, changeModel.filePath]);
			}
		}
		if (!args.length) {
			await vscode.window.showInformationMessage(vscode.l10n.t('No matching files found to open.'));
			return;
		}
		if (vscode.window.tabGroups.all.length < 2) {
			await vscode.commands.executeCommand('workbench.action.splitEditor');
		}
		await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');
		const title = groupName
			? vscode.l10n.t('Changes in Pull Request #{0}: {1}', this._item.number.toString(), groupName)
			: vscode.l10n.t('Changes in Pull Request #{0}', this._item.number.toString());
		return vscode.commands.executeCommand('vscode.changes', title, args);
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
		const nonce = generateUuid();
		const totals = files.reduce(
			(acc, file) => {
				acc.additions += file.additions;
				acc.deletions += file.deletions;
				return acc;
			},
			{ additions: 0, deletions: 0 },
		);
		const fileItems = files.map((file, index) => {
			return {
				id: `file-${index}`,
				fileName: file.filename,
				label: formatFileLabel(file),
				status: file.status,
				additions: file.additions,
				deletions: file.deletions,
			};
		});

		const totalText = vscode.l10n.t('{0} files changed', files.length.toString());
		const diffText = vscode.l10n.t('+{0} -{1}', totals.additions.toString(), totals.deletions.toString());
		const defaultGroupName = vscode.l10n.t('Changed Files');
		const emptyGroupText = vscode.l10n.t('Drop files here');
		const newGroupBaseName = vscode.l10n.t('New Group');
		const duplicateGroupMessage = vscode.l10n.t('A group with that name already exists.');
		const openChangesLabel = vscode.l10n.t('Open Changes');

		return `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
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
			.toolbar {
				display: flex;
				align-items: center;
				justify-content: space-between;
				gap: 12px;
				margin-bottom: 6px;
			}
			h1 {
				font-size: 16px;
				margin: 0;
			}
			button {
				background: var(--vscode-button-background);
				color: var(--vscode-button-foreground);
				border: 1px solid var(--vscode-button-border, transparent);
				border-radius: 4px;
				padding: 4px 10px;
				font-size: 12px;
				cursor: pointer;
			}
			button:hover {
				background: var(--vscode-button-hoverBackground);
			}
			button:disabled {
				opacity: 0.6;
				cursor: default;
			}
			.summary {
				color: var(--vscode-descriptionForeground);
				margin-bottom: 12px;
				font-size: 12px;
			}
			.groups {
				display: grid;
				gap: 12px;
			}
			.group {
				border: 1px solid var(--vscode-editorWidget-border);
				border-radius: 6px;
				padding: 8px;
				background: var(--vscode-editorWidget-background);
			}
			.group-header {
				display: flex;
				align-items: center;
				justify-content: space-between;
				margin-bottom: 6px;
				gap: 8px;
			}
			.group-title {
				font-size: 13px;
				font-weight: 600;
				background: transparent;
				border: 1px solid transparent;
				color: inherit;
				padding: 2px 4px;
				border-radius: 4px;
				width: 100%;
			}
			.group-title:focus {
				outline: none;
				border-color: var(--vscode-focusBorder);
				background: var(--vscode-input-background);
			}
			.group-count {
				font-size: 11px;
				color: var(--vscode-descriptionForeground);
				white-space: nowrap;
			}
			.group-body {
				display: grid;
				gap: 6px;
				min-height: 24px;
			}
			.group-body.drag-over {
				outline: 1px dashed var(--vscode-focusBorder);
				outline-offset: 2px;
			}
			.file-item {
				display: grid;
				grid-template-columns: 1fr auto auto auto;
				gap: 8px;
				align-items: center;
				padding: 6px 8px;
				border-radius: 4px;
				background: var(--vscode-editor-background);
				border: 1px solid var(--vscode-input-border, transparent);
				font-size: 12px;
			}
			.file-item[draggable="true"] {
				cursor: grab;
			}
			.file-label {
				font-family: var(--vscode-editor-font-family);
			}
			.file-status {
				font-weight: 600;
				font-size: 11px;
				text-transform: uppercase;
			}
			.file-count {
				white-space: nowrap;
				font-size: 11px;
			}
			.empty-group {
				color: var(--vscode-descriptionForeground);
				font-size: 11px;
				padding: 4px 6px;
				border: 1px dashed var(--vscode-editorWidget-border);
				border-radius: 4px;
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
		<div class="toolbar">
			<h1>${vscode.l10n.t('Changed Files')}</h1>
			<button id="create-group" type="button">${vscode.l10n.t('New Group')}</button>
		</div>
		<div class="summary">${escapeHtml(totalText)} &nbsp; ${escapeHtml(diffText)}</div>
		<div id="groups" class="groups" aria-label="${vscode.l10n.t('Changed files groups')}"></div>
		<script nonce="${nonce}">
			const files = ${serializeForScript(fileItems)};
			const defaultGroupName = ${serializeForScript(defaultGroupName)};
			const emptyGroupText = ${serializeForScript(emptyGroupText)};
			const newGroupBaseName = ${serializeForScript(newGroupBaseName)};
			const duplicateGroupMessage = ${serializeForScript(duplicateGroupMessage)};
			const openChangesLabel = ${serializeForScript(openChangesLabel)};
			const vscodeApi = acquireVsCodeApi();
			let groupCounter = 1;
			const groups = [
				{ id: 'group-' + groupCounter, name: defaultGroupName, fileIds: files.map(file => file.id) },
			];

			const groupsRoot = document.getElementById('groups');
			const createGroupButton = document.getElementById('create-group');

			function normalizeName(name) {
				return name.trim().toLowerCase();
			}

			function isGroupNameTaken(name, excludeGroupId) {
				const target = normalizeName(name);
				return groups.some(group => group.id !== excludeGroupId && normalizeName(group.name) === target);
			}

			function getUniqueGroupName(baseName) {
				let suffix = groups.length + 1;
				let candidate = baseName;
				while (isGroupNameTaken(candidate)) {
					candidate = baseName + ' ' + suffix;
					suffix += 1;
				}
				return candidate;
			}

			function moveFileToGroup(fileId, targetGroupId) {
				groups.forEach(group => {
					const index = group.fileIds.indexOf(fileId);
					if (index !== -1) {
						group.fileIds.splice(index, 1);
					}
				});
				const targetGroup = groups.find(group => group.id === targetGroupId);
				if (targetGroup) {
					targetGroup.fileIds.push(fileId);
				}
				render();
			}

			function createFileElement(file) {
				const row = document.createElement('div');
				row.className = 'file-item';
				row.draggable = true;
				row.dataset.fileId = file.id;
				const label = document.createElement('div');
				label.className = 'file-label';
				label.textContent = file.label;
				const status = document.createElement('div');
				status.className = 'file-status status-' + file.status;
				status.textContent = file.status.toUpperCase();
				const additions = document.createElement('div');
				additions.className = 'file-count status-' + file.status;
				additions.textContent = '+' + file.additions;
				const deletions = document.createElement('div');
				deletions.className = 'file-count status-' + file.status;
				deletions.textContent = '-' + file.deletions;
				row.appendChild(label);
				row.appendChild(status);
				row.appendChild(additions);
				row.appendChild(deletions);
				row.addEventListener('dragstart', event => {
					if (!event.dataTransfer) {
						return;
					}
					event.dataTransfer.setData('application/x-pr-file-id', file.id);
					event.dataTransfer.setData('text/plain', file.id);
					event.dataTransfer.effectAllowed = 'move';
				});
				return row;
			}

			function createGroupElement(group) {
				const container = document.createElement('section');
				container.className = 'group';
				container.dataset.groupId = group.id;
				const header = document.createElement('div');
				header.className = 'group-header';
				const title = document.createElement('input');
				title.className = 'group-title';
				title.type = 'text';
				title.value = group.name;
				title.setAttribute('aria-label', 'Group name');
				title.dataset.previousName = group.name;
				title.addEventListener('change', () => {
					const trimmed = title.value.trim();
					const previousName = title.dataset.previousName || group.name;
					if (!trimmed) {
						title.value = previousName;
						return;
					}
					if (isGroupNameTaken(trimmed, group.id)) {
						window.alert(duplicateGroupMessage);
						title.value = previousName;
						return;
					}
					group.name = trimmed;
					title.dataset.previousName = trimmed;
					title.value = trimmed;
				});
				const count = document.createElement('div');
				count.className = 'group-count';
				count.textContent = group.fileIds.length + ' ' + (group.fileIds.length === 1 ? 'file' : 'files');
				const openButton = document.createElement('button');
				openButton.type = 'button';
				openButton.textContent = openChangesLabel;
				openButton.disabled = group.fileIds.length === 0;
				openButton.addEventListener('click', () => {
					const groupFileNames = group.fileIds
						.map(fileId => files.find(item => item.id === fileId))
						.filter(file => file && file.fileName)
						.map(file => file.fileName);
					vscodeApi.postMessage({
						command: 'openGroupChanges',
						fileNames: groupFileNames,
						groupName: group.name,
					});
				});
				header.appendChild(title);
				header.appendChild(count);
				header.appendChild(openButton);
				const body = document.createElement('div');
				body.className = 'group-body';
				body.addEventListener('dragover', event => {
					event.preventDefault();
					body.classList.add('drag-over');
					if (event.dataTransfer) {
						event.dataTransfer.dropEffect = 'move';
					}
				});
				body.addEventListener('dragleave', () => body.classList.remove('drag-over'));
				body.addEventListener('drop', event => {
					event.preventDefault();
					body.classList.remove('drag-over');
					if (!event.dataTransfer) {
						return;
					}
					const fileId = event.dataTransfer.getData('application/x-pr-file-id') || event.dataTransfer.getData('text/plain');
					if (fileId) {
						moveFileToGroup(fileId, group.id);
					}
				});
				if (group.fileIds.length === 0) {
					const empty = document.createElement('div');
					empty.className = 'empty-group';
					empty.textContent = emptyGroupText;
					body.appendChild(empty);
				} else {
					group.fileIds.forEach(fileId => {
						const file = files.find(item => item.id === fileId);
						if (file) {
							body.appendChild(createFileElement(file));
						}
					});
				}
				container.appendChild(header);
				container.appendChild(body);
				return container;
			}

			function render() {
				groupsRoot.innerHTML = '';
				if (files.length === 0) {
					const empty = document.createElement('div');
					empty.className = 'empty-group';
					empty.textContent = ${serializeForScript(vscode.l10n.t('No changed files found.'))};
					groupsRoot.appendChild(empty);
					return;
				}
				groups.forEach(group => {
					groupsRoot.appendChild(createGroupElement(group));
				});
			}

			createGroupButton.addEventListener('click', () => {
				groupCounter += 1;
				const name = getUniqueGroupName(newGroupBaseName);
				groups.push({ id: 'group-' + groupCounter, name: name, fileIds: [] });
				render();
			});

			render();
		</script>
	</body>
</html>`;
	}
}
