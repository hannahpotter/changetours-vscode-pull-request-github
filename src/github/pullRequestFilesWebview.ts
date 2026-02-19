/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { FolderRepositoryManager } from './folderRepositoryManager';
import { IRawFileChange } from './interface';
import { PullRequestModel } from './pullRequestModel';
import { parsePatch } from '../common/diffHunk';
import Logger from '../common/logger';
import { formatError } from '../common/utils';
import { generateUuid } from '../common/uuid';

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
			const hunks = file.patch ? parsePatch(file.patch) : [];
			const hunkItems = hunks.map((hunk, hunkIndex) => {
				const lines = hunk.diffLines.map(diffLine => ({
					type: diffLine.type,
					oldLineNumber: diffLine.oldLineNumber,
					newLineNumber: diffLine.newLineNumber,
					text: diffLine.raw,
				}));
				return {
					id: `hunk-${index}-${hunkIndex}`,
					oldLineNumber: hunk.oldLineNumber,
					oldLength: hunk.oldLength,
					newLineNumber: hunk.newLineNumber,
					newLength: hunk.newLength,
					lines: lines,
				};
			});
			return {
				id: `file-${index}`,
				fileName: file.filename,
				label: formatFileLabel(file),
				status: file.status,
				additions: file.additions,
				deletions: file.deletions,
				hunks: hunkItems,
			};
		});

		const totalText = vscode.l10n.t('{0} files changed', files.length.toString());
		const diffText = vscode.l10n.t('+{0} -{1}', totals.additions.toString(), totals.deletions.toString());
		const defaultGroupName = vscode.l10n.t('Changed Files');
		const emptyGroupText = vscode.l10n.t('Drop files here');
		const newGroupBaseName = vscode.l10n.t('New Group');
		const newSubgroupBaseName = vscode.l10n.t('New Subgroup');
		const duplicateGroupMessage = vscode.l10n.t('A group with that name already exists.');
		const openChangesLabel = vscode.l10n.t('Open Changes');
		const addSubgroupLabel = vscode.l10n.t('Add Subgroup');
		const collapseLabel = vscode.l10n.t('Collapse');
		const expandLabel = vscode.l10n.t('Expand');

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
			.subgroups {
				display: grid;
				gap: 8px;
				margin-top: 8px;
			}
			.subgroup {
				border: 1px dashed var(--vscode-editorWidget-border);
				border-radius: 6px;
				padding: 6px;
				background: var(--vscode-editor-background);
			}
			.subgroup-header {
				display: flex;
				align-items: center;
				justify-content: space-between;
				margin-bottom: 6px;
				gap: 8px;
			}
			.subgroup-title {
				font-size: 12px;
				font-weight: 600;
				background: transparent;
				border: 1px solid transparent;
				color: inherit;
				padding: 2px 4px;
				border-radius: 4px;
				width: 100%;
			}
			.subgroup-title:focus {
				outline: none;
				border-color: var(--vscode-focusBorder);
				background: var(--vscode-input-background);
			}
			.subgroup-count {
				font-size: 11px;
				color: var(--vscode-descriptionForeground);
				white-space: nowrap;
			}
			.subgroup-body {
				display: grid;
				gap: 6px;
				min-height: 24px;
			}
			.subgroup-body.drag-over {
				outline: 1px dashed var(--vscode-focusBorder);
				outline-offset: 2px;
			}
			.subgroup-body.is-collapsed {
				display: none;
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
			.group-body.is-collapsed {
				display: none;
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
			.file-hunks {
				display: grid;
				gap: 12px;
				padding: 8px 0;
				margin-top: 8px;
				border-top: 1px solid var(--vscode-editorWidget-border);
			}
			.hunk {
				border: 1px solid var(--vscode-editorWidget-border);
				border-radius: 4px;
				background: var(--vscode-editorWidget-background);
				overflow: hidden;
				cursor: grab;
				transition: all 0.2s ease;
				user-select: none;
			}
			.hunk:hover {
				border-color: var(--vscode-focusBorder);
				box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
			}
			.hunk.dragging {
				opacity: 0.5;
				cursor: grabbing;
			}
			.hunk.drag-over {
				border-color: var(--vscode-focusBorder);
				background: var(--vscode-list-hoverBackground);
				box-shadow: 0 0 0 2px var(--vscode-focusBorder);
			}
			.hunk-header {
				background: var(--vscode-editorCodeLens-background);
				color: var(--vscode-editorCodeLens-foreground);
				padding: 4px 8px;
				font-size: 11px;
				font-family: var(--vscode-editor-font-family);
				white-space: pre;
				overflow-x: auto;
			}
			.hunk-lines {
				display: grid;
				gap: 0;
			}
			.diff-line {
				padding: 2px 8px;
				font-family: var(--vscode-editor-font-family);
				font-size: 12px;
				white-space: pre-wrap;
				word-wrap: break-word;
				margin: 0;
			}
			.diff-line-header {
				background: var(--vscode-editorCodeLens-background);
				color: var(--vscode-editorCodeLens-foreground);
				padding: 2px 4px;
				margin: 4px 0 0 0;
			}
			.diff-line-added {
				background: var(--vscode-diffEditor-insertedLineBackground);
				color: var(--vscode-gitDecoration-addedResourceForeground);
			}
			.diff-line-removed {
				background: var(--vscode-diffEditor-removedLineBackground);
				color: var(--vscode-gitDecoration-deletedResourceForeground);
			}
			.diff-line-context {
				background: transparent;
				color: var(--vscode-foreground);
			}
			.text-item {
				display: grid;
				grid-template-columns: 1fr auto auto;
				gap: 8px;
				align-items: center;
				padding: 6px 8px;
				border-radius: 4px;
				background: var(--vscode-notebook-cellTagDefault-background);
				border: 1px solid var(--vscode-input-border, transparent);
				font-size: 12px;
			}
			.text-item[draggable="true"] {
				cursor: grab;
			}
			.text-label {
				font-family: var(--vscode-editor-font-family);
				word-break: break-word;
			}
			.text-item-input {
				background: var(--vscode-input-background);
				color: var(--vscode-input-foreground);
				border: 1px solid var(--vscode-input-border);
				border-radius: 3px;
				padding: 4px 6px;
				font-family: var(--vscode-editor-font-family);
				font-size: 12px;
				flex: 1;
				grid-column: 1;
			}
			.text-item-input::placeholder {
				color: var(--vscode-input-placeholderForeground);
			}
			.text-item-input:focus {
				outline: none;
				border-color: var(--vscode-focusBorder);
			}
			.text-item-confirm,
			.text-item-cancel {
				background: transparent;
				color: var(--vscode-foreground);
				border: none;
				padding: 4px 8px;
				cursor: pointer;
				border-radius: 3px;
				font-size: 12px;
				line-height: 1;
				white-space: nowrap;
			}
			.text-item-confirm:hover,
			.text-item-cancel:hover {
				background: var(--vscode-editor-lineHighlightBackground);
			}
			.text-item-edit,
			.text-item-delete {
				background: transparent;
				color: var(--vscode-foreground);
				border: none;
				padding: 4px 8px;
				cursor: pointer;
				border-radius: 3px;
				font-size: 12px;
				line-height: 1;
				white-space: nowrap;
			}
			.text-item-edit:hover,
			.text-item-delete:hover {
				background: var(--vscode-editor-lineHighlightBackground);
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
			const newSubgroupBaseName = ${serializeForScript(newSubgroupBaseName)};
			const addSubgroupLabel = ${serializeForScript(addSubgroupLabel)};
			const collapseLabel = ${serializeForScript(collapseLabel)};
			const expandLabel = ${serializeForScript(expandLabel)};
			const vscodeApi = acquireVsCodeApi();
			let groupCounter = 1;
			let subgroupCounter = 1;
			let textItemCounter = 1;
			const collapsedGroups = new Set();
			const collapsedSubgroups = new Set();
			const collapsedFiles = new Set();
			const editingTextItems = new Set();

			// Type constants matching DiffChangeType from diffHunk.ts
			const DiffChangeType = {
				Context: 0,
				Add: 1,
				Delete: 2,
				Control: 3,
			};

			// File tracking for hunk drag-and-drop
			let draggedHunk = null;
			let draggedFromFileIndex = null;
			let draggedFromHunkIndex = null;
			const groups = [
				{ id: 'group-' + groupCounter, name: defaultGroupName, fileIds: files.map(file => file.id), subgroups: [], textItems: [], itemOrder: files.map(file => file.id) },
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

			function isSubgroupNameTaken(group, name, excludeSubgroupId) {
				const target = normalizeName(name);
				return group.subgroups.some(subgroup => subgroup.id !== excludeSubgroupId && normalizeName(subgroup.name) === target);
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

			function getUniqueSubgroupName(group, baseName) {
				let suffix = group.subgroups.length + 1;
				let candidate = baseName;
				while (isSubgroupNameTaken(group, candidate)) {
					candidate = baseName + ' ' + suffix;
					suffix += 1;
				}
				return candidate;
			}

			function getGroupTotalCount(group) {
				return group.fileIds.length + group.subgroups.reduce((total, subgroup) => total + subgroup.fileIds.length, 0);
			}

			function getGroupFileNames(group) {
				const ids = group.fileIds.slice();
				group.subgroups.forEach(subgroup => ids.push(...subgroup.fileIds));
				return ids
					.map(fileId => files.find(item => item.id === fileId))
					.filter(file => file && file.fileName)
					.map(file => file.fileName);
			}

			function moveFileToGroup(fileId, targetGroupId, targetSubgroupId) {
				groups.forEach(group => {
					const index = group.fileIds.indexOf(fileId);
					if (index !== -1) {
						group.fileIds.splice(index, 1);
					}
					const orderIndex = group.itemOrder.indexOf(fileId);
					if (orderIndex !== -1) {
						group.itemOrder.splice(orderIndex, 1);
					}
					group.subgroups.forEach(subgroup => {
						const subgroupIndex = subgroup.fileIds.indexOf(fileId);
						if (subgroupIndex !== -1) {
							subgroup.fileIds.splice(subgroupIndex, 1);
						}
						const subgroupOrderIndex = subgroup.itemOrder.indexOf(fileId);
						if (subgroupOrderIndex !== -1) {
							subgroup.itemOrder.splice(subgroupOrderIndex, 1);
						}
					});
				});
				const targetGroup = groups.find(group => group.id === targetGroupId);
				if (targetGroup) {
					if (targetSubgroupId) {
						const targetSubgroup = targetGroup.subgroups.find(subgroup => subgroup.id === targetSubgroupId);
						if (targetSubgroup) {
							targetSubgroup.fileIds.push(fileId);
							targetSubgroup.itemOrder = targetSubgroup.itemOrder || [];
							targetSubgroup.itemOrder.push(fileId);
						} else {
							targetGroup.fileIds.push(fileId);
							targetGroup.itemOrder.push(fileId);
						}
					} else {
						targetGroup.fileIds.push(fileId);
						targetGroup.itemOrder.push(fileId);
					}
				}
				render();
			}

			function moveTextItemToGroup(textItemId, targetGroupId, targetSubgroupId) {
				let sourceTextItem = null;
				let sourceContainer = null;
				groups.forEach(group => {
					const index = group.textItems.indexOf(textItemId);
					if (index !== -1) {
						sourceTextItem = group.textItemsMap && group.textItemsMap[textItemId];
						sourceContainer = group;
						group.textItems.splice(index, 1);
					}
					const orderIndex = group.itemOrder.indexOf(textItemId);
					if (orderIndex !== -1) {
						group.itemOrder.splice(orderIndex, 1);
					}
					group.subgroups.forEach(subgroup => {
						const subgroupIndex = subgroup.textItems.indexOf(textItemId);
						if (subgroupIndex !== -1) {
							sourceTextItem = subgroup.textItemsMap && subgroup.textItemsMap[textItemId];
							sourceContainer = subgroup;
							subgroup.textItems.splice(subgroupIndex, 1);
						}
						const subgroupOrderIndex = subgroup.itemOrder.indexOf(textItemId);
						if (subgroupOrderIndex !== -1) {
							subgroup.itemOrder.splice(subgroupOrderIndex, 1);
						}
					});
				});
				const targetGroup = groups.find(group => group.id === targetGroupId);
				if (targetGroup && sourceTextItem && sourceContainer) {
					if (targetSubgroupId) {
						const targetSubgroup = targetGroup.subgroups.find(subgroup => subgroup.id === targetSubgroupId);
						if (targetSubgroup) {
							targetSubgroup.textItems.push(textItemId);
							targetSubgroup.itemOrder = targetSubgroup.itemOrder || [];
							targetSubgroup.itemOrder.push(textItemId);
							targetSubgroup.textItemsMap = targetSubgroup.textItemsMap || {};
							targetSubgroup.textItemsMap[textItemId] = sourceTextItem;
							if (sourceContainer.textItemsMap && sourceContainer.textItemsMap[textItemId]) {
								delete sourceContainer.textItemsMap[textItemId];
							}
						} else {
							targetGroup.textItems.push(textItemId);
							targetGroup.itemOrder.push(textItemId);
							targetGroup.textItemsMap = targetGroup.textItemsMap || {};
							targetGroup.textItemsMap[textItemId] = sourceTextItem;
							if (sourceContainer.textItemsMap && sourceContainer.textItemsMap[textItemId]) {
								delete sourceContainer.textItemsMap[textItemId];
							}
						}
					} else {
						targetGroup.textItems.push(textItemId);
						targetGroup.itemOrder.push(textItemId);
						targetGroup.textItemsMap = targetGroup.textItemsMap || {};
						targetGroup.textItemsMap[textItemId] = sourceTextItem;
						if (sourceContainer.textItemsMap && sourceContainer.textItemsMap[textItemId]) {
							delete sourceContainer.textItemsMap[textItemId];
						}
					}
				}
				render();
			}

			function reorderItemWithinGroup(itemId, groupId, subgroupId, moveUp) {
				let container = null;
				const group = groups.find(g => g.id === groupId);
				if (!group) {
					return;
				}
				if (subgroupId) {
					container = group.subgroups.find(sg => sg.id === subgroupId);
				} else {
					container = group;
				}
				if (!container || !container.itemOrder) {
					return;
				}
				const index = container.itemOrder.indexOf(itemId);
				if (index === -1) {
					return;
				}
				const newIndex = moveUp ? index - 1 : index + 1;
				if (newIndex < 0 || newIndex >= container.itemOrder.length) {
					return;
				}
				const temp = container.itemOrder[index];
				container.itemOrder[index] = container.itemOrder[newIndex];
				container.itemOrder[newIndex] = temp;
				render();
			}

			function isGroupCollapsed(groupId) {
				return collapsedGroups.has(groupId);
			}

			function isSubgroupCollapsed(subgroupId) {
				return collapsedSubgroups.has(subgroupId);
			}

			function toggleGroupCollapsed(groupId) {
				if (collapsedGroups.has(groupId)) {
					collapsedGroups.delete(groupId);
				} else {
					collapsedGroups.add(groupId);
				}
				render();
			}

			function toggleSubgroupCollapsed(subgroupId) {
				if (collapsedSubgroups.has(subgroupId)) {
					collapsedSubgroups.delete(subgroupId);
				} else {
					collapsedSubgroups.add(subgroupId);
				}
				render();
			}

			function toggleTextItemEditMode(textItemId) {
				if (editingTextItems.has(textItemId)) {
					editingTextItems.delete(textItemId);
				} else {
					editingTextItems.add(textItemId);
				}
				render();
			}

			function toggleFileCollapsed(fileId) {
				if (collapsedFiles.has(fileId)) {
					collapsedFiles.delete(fileId);
				} else {
					collapsedFiles.add(fileId);
				}
				render();
			}

			function isFileCollapsed(fileId) {
				return collapsedFiles.has(fileId);
			}

			function createHunkElement(file, hunk, fileIndex, hunkIndex) {
				const hunkContainer = document.createElement('div');
				hunkContainer.className = 'hunk';
				hunkContainer.draggable = true;
				hunkContainer.dataset.fileIndex = fileIndex;
				hunkContainer.dataset.hunkIndex = hunkIndex;

				// Drag events for hunk reordering
				hunkContainer.addEventListener('dragstart', (e) => {
					draggedHunk = hunk;
					draggedFromFileIndex = fileIndex;
					draggedFromHunkIndex = hunkIndex;
					e.dataTransfer.effectAllowed = 'move';
					hunkContainer.classList.add('dragging');
				});

				hunkContainer.addEventListener('dragend', (e) => {
					hunkContainer.classList.remove('dragging');
					draggedHunk = null;
					draggedFromFileIndex = null;
					draggedFromHunkIndex = null;
					document.querySelectorAll('.hunk.drag-over').forEach(el => {
						el.classList.remove('drag-over');
					});
				});

				hunkContainer.addEventListener('dragover', (e) => {
					if (draggedHunk) {
						e.preventDefault();
						e.dataTransfer.dropEffect = 'move';
						hunkContainer.classList.add('drag-over');
					}
				});

				hunkContainer.addEventListener('dragleave', (e) => {
					hunkContainer.classList.remove('drag-over');
				});

				hunkContainer.addEventListener('drop', (e) => {
					e.preventDefault();
					if (draggedHunk && draggedFromFileIndex === fileIndex && draggedFromHunkIndex !== hunkIndex) {
						// Reorder hunks within the same file
						const hunks = files[fileIndex].hunks;
						const [removed] = hunks.splice(draggedFromHunkIndex, 1);
						const targetIndex = draggedFromHunkIndex < hunkIndex ? hunkIndex - 1 : hunkIndex;
						hunks.splice(targetIndex, 0, removed);
						render();
					}
					hunkContainer.classList.remove('drag-over');
				});

				const header = document.createElement('div');
				header.className = 'hunk-header';
				header.style.pointerEvents = 'none';
				header.textContent = '@@ -' + hunk.oldLineNumber + ',' + hunk.oldLength + ' +' + hunk.newLineNumber + ',' + hunk.newLength + ' @@';

				const linesContainer = document.createElement('div');
				linesContainer.className = 'hunk-lines';
				linesContainer.style.pointerEvents = 'none';

				for (const diffLine of hunk.lines) {
					const lineElement = document.createElement('div');
					lineElement.className = 'diff-line';

					if (diffLine.type === DiffChangeType.Add) {
						lineElement.className += ' diff-line-added';
					} else if (diffLine.type === DiffChangeType.Delete) {
						lineElement.className += ' diff-line-removed';
					} else if (diffLine.type === DiffChangeType.Control) {
						lineElement.className += ' diff-line-header';
					} else {
						lineElement.className += ' diff-line-context';
					}

					lineElement.textContent = diffLine.text;
					linesContainer.appendChild(lineElement);
				}

				hunkContainer.appendChild(header);
				hunkContainer.appendChild(linesContainer);

				return hunkContainer;
			}

			function createFileElement(file, fileIndex) {
				const row = document.createElement('div');
				row.className = 'file-item';
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

				// Add hunks if available
				if (file.hunks && file.hunks.length > 0) {
					const hunksContainer = document.createElement('div');
					hunksContainer.className = 'file-hunks';

					// Toggle button for hunks
					const toggleButton = document.createElement('button');
					toggleButton.type = 'button';
					toggleButton.textContent = isFileCollapsed(file.id) ? expandLabel : collapseLabel;
					toggleButton.style.gridColumn = '1';
					toggleButton.style.marginBottom = '-8px';
					toggleButton.style.fontSize = '11px';
					toggleButton.style.padding = '2px 4px';
					toggleButton.addEventListener('click', () => toggleFileCollapsed(file.id));

					hunksContainer.appendChild(toggleButton);

					if (!isFileCollapsed(file.id)) {
						for (let hunkIndex = 0; hunkIndex < file.hunks.length; hunkIndex++) {
							const hunk = file.hunks[hunkIndex];
							hunksContainer.appendChild(createHunkElement(file, hunk, fileIndex, hunkIndex));
						}
					}

					row.appendChild(hunksContainer);
				}

				return row;
			}

			function createTextItemElement(textItem, group, subgroup, isEditing) {
				const row = document.createElement('div');
				row.className = 'text-item';
				const isInEditMode = isEditing || editingTextItems.has(textItem.id);
				if (!isInEditMode) {
					row.draggable = true;
				}
				row.dataset.textItemId = textItem.id;
				if (isInEditMode) {
					const input = document.createElement('input');
					input.type = 'text';
					input.className = 'text-item-input';
					input.value = textItem.text;
					input.placeholder = 'Enter note text...';
					const confirmButton = document.createElement('button');
					confirmButton.type = 'button';
					confirmButton.className = 'text-item-confirm';
					confirmButton.textContent = 'Save';
					confirmButton.title = 'Save note';
					confirmButton.addEventListener('click', () => {
						const trimmed = input.value.trim();
						if (trimmed) {
							textItem.text = trimmed;
							editingTextItems.delete(textItem.id);
							render();
						}
					});
					const cancelButton = document.createElement('button');
					cancelButton.type = 'button';
					cancelButton.className = 'text-item-cancel';
					cancelButton.textContent = 'Cancel';
					cancelButton.title = 'Cancel';
					cancelButton.addEventListener('click', () => {
						editingTextItems.delete(textItem.id);
						if (textItem.text === '') {
							if (subgroup) {
								const index = subgroup.textItems.indexOf(textItem.id);
								if (index !== -1) {
									subgroup.textItems.splice(index, 1);
								}
							} else {
								const index = group.textItems.indexOf(textItem.id);
								if (index !== -1) {
									group.textItems.splice(index, 1);
								}
							}
						}
						render();
					});
					row.appendChild(input);
					row.appendChild(confirmButton);
					row.appendChild(cancelButton);
					setTimeout(() => input.focus(), 0);
				} else {
					const label = document.createElement('div');
					label.className = 'text-label';
					label.textContent = textItem.text;
					const editButton = document.createElement('button');
					editButton.type = 'button';
					editButton.className = 'text-item-edit';
					editButton.textContent = 'Edit';
					editButton.title = 'Edit note';
					editButton.addEventListener('click', () => {
						toggleTextItemEditMode(textItem.id);
					});
					const deleteButton = document.createElement('button');
					deleteButton.type = 'button';
					deleteButton.className = 'text-item-delete';
					deleteButton.textContent = 'Delete';
					deleteButton.title = 'Delete note';
					deleteButton.addEventListener('click', () => {
						editingTextItems.delete(textItem.id);
						if (subgroup) {
							const index = subgroup.textItems.indexOf(textItem.id);
							if (index !== -1) {
								subgroup.textItems.splice(index, 1);
							}
						} else {
							const index = group.textItems.indexOf(textItem.id);
							if (index !== -1) {
								group.textItems.splice(index, 1);
							}
						}
						render();
					});
					row.appendChild(label);
					row.appendChild(editButton);
					row.appendChild(deleteButton);
					row.addEventListener('dragstart', event => {
						if (!event.dataTransfer) {
							return;
						}
						event.dataTransfer.setData('application/x-pr-text-item-id', textItem.id);
						event.dataTransfer.setData('text/plain', textItem.id);
						event.dataTransfer.effectAllowed = 'move';
					});
				}
				return row;
			}

			function createSubgroupElement(group, subgroup) {
				const container = document.createElement('section');
				container.className = 'subgroup';
				container.dataset.groupId = group.id;
				container.dataset.subgroupId = subgroup.id;
				const header = document.createElement('div');
				header.className = 'subgroup-header';
				const title = document.createElement('input');
				title.className = 'subgroup-title';
				title.type = 'text';
				title.value = subgroup.name;
				title.setAttribute('aria-label', 'Subgroup name');
				title.dataset.previousName = subgroup.name;
				title.addEventListener('change', () => {
					const trimmed = title.value.trim();
					const previousName = title.dataset.previousName || subgroup.name;
					if (!trimmed) {
						title.value = previousName;
						return;
					}
					if (isSubgroupNameTaken(group, trimmed, subgroup.id)) {
						window.alert(duplicateGroupMessage);
						title.value = previousName;
						return;
					}
					subgroup.name = trimmed;
					title.dataset.previousName = trimmed;
					title.value = trimmed;
				});
				const count = document.createElement('div');
				count.className = 'subgroup-count';
				count.textContent = subgroup.fileIds.length + ' ' + (subgroup.fileIds.length === 1 ? 'file' : 'files');
				const addNoteButton = document.createElement('button');
				addNoteButton.type = 'button';
				addNoteButton.textContent = 'Add Note';
				addNoteButton.addEventListener('click', () => {
					textItemCounter += 1;
					subgroup.textItems = subgroup.textItems || [];
					const textItemId = 'text-item-' + textItemCounter;
					subgroup.textItems.push(textItemId);
					subgroup.itemOrder = subgroup.itemOrder || [];
					subgroup.itemOrder.push(textItemId);
					subgroup.textItemsMap = subgroup.textItemsMap || {};
					subgroup.textItemsMap[textItemId] = { id: textItemId, text: '' };
					render();
				});
				const openButton = document.createElement('button');
				openButton.type = 'button';
				openButton.textContent = openChangesLabel;
				openButton.disabled = subgroup.fileIds.length === 0;
				openButton.addEventListener('click', () => {
					const subgroupFileNames = subgroup.fileIds
						.map(fileId => files.find(item => item.id === fileId))
						.filter(file => file && file.fileName)
						.map(file => file.fileName);
					vscodeApi.postMessage({
						command: 'openGroupChanges',
						fileNames: subgroupFileNames,
						groupName: group.name + ' / ' + subgroup.name,
					});
				});
				const collapseButton = document.createElement('button');
				collapseButton.type = 'button';
				collapseButton.textContent = isSubgroupCollapsed(subgroup.id) ? expandLabel : collapseLabel;
				collapseButton.addEventListener('click', () => toggleSubgroupCollapsed(subgroup.id));
				header.appendChild(title);
				header.appendChild(count);
				header.appendChild(addNoteButton);
				header.appendChild(openButton);
				header.appendChild(collapseButton);
				const body = document.createElement('div');
				body.className = 'subgroup-body';
				if (isSubgroupCollapsed(subgroup.id)) {
					body.classList.add('is-collapsed');
				}
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
					const fileId = event.dataTransfer.getData('application/x-pr-file-id');
					const textItemId = event.dataTransfer.getData('application/x-pr-text-item-id');
					if (fileId) {
						moveFileToGroup(fileId, group.id, subgroup.id);
					} else if (textItemId) {
						moveTextItemToGroup(textItemId, group.id, subgroup.id);
					}
				});
				if (subgroup.fileIds.length === 0 && (!subgroup.textItems || subgroup.textItems.length === 0)) {
					const empty = document.createElement('div');
					empty.className = 'empty-group';
					empty.textContent = emptyGroupText;
					body.appendChild(empty);
				} else {
					const itemOrder = subgroup.itemOrder || [];
					itemOrder.forEach(itemId => {
						if (itemId.startsWith('file-')) {
							const file = files.find(item => item.id === itemId);
							if (file) {
								const fileIndex = files.indexOf(file);
								body.appendChild(createFileElement(file, fileIndex));
							}
						} else if (itemId.startsWith('text-item-')) {
							const textItem = subgroup.textItemsMap && subgroup.textItemsMap[itemId];
							if (textItem) {
								const isEditing = textItem.text === '';
								body.appendChild(createTextItemElement(textItem, group, subgroup, isEditing));
							}
						}
					});
				}
				container.appendChild(header);
				if (!isSubgroupCollapsed(subgroup.id)) {
					container.appendChild(body);
				}
				return container;
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
				const totalCount = getGroupTotalCount(group);
				count.textContent = totalCount + ' ' + (totalCount === 1 ? 'file' : 'files');
				const addSubgroupButton = document.createElement('button');
				addSubgroupButton.type = 'button';
				addSubgroupButton.textContent = addSubgroupLabel;
				addSubgroupButton.addEventListener('click', () => {
					subgroupCounter += 1;
					const name = getUniqueSubgroupName(group, newSubgroupBaseName);
					group.subgroups.push({ id: 'subgroup-' + subgroupCounter, name: name, fileIds: [], textItems: [], textItemsMap: {}, itemOrder: [] });
					render();
				});
				const addNoteButton = document.createElement('button');
				addNoteButton.type = 'button';
				addNoteButton.textContent = 'Add Note';
				addNoteButton.addEventListener('click', () => {
					textItemCounter += 1;
					group.textItems = group.textItems || [];
					group.textItemsMap = group.textItemsMap || {};
					group.itemOrder = group.itemOrder || [];
					const textItemId = 'text-item-' + textItemCounter;
					group.textItems.push(textItemId);
					group.itemOrder.push(textItemId);
					group.textItemsMap[textItemId] = { id: textItemId, text: '' };
					render();
				});
				const openButton = document.createElement('button');
				openButton.type = 'button';
				openButton.textContent = openChangesLabel;
				openButton.disabled = totalCount === 0;
				openButton.addEventListener('click', () => {
					const groupFileNames = getGroupFileNames(group);
					vscodeApi.postMessage({
						command: 'openGroupChanges',
						fileNames: groupFileNames,
						groupName: group.name,
					});
				});
				const collapseButton = document.createElement('button');
				collapseButton.type = 'button';
				collapseButton.textContent = isGroupCollapsed(group.id) ? expandLabel : collapseLabel;
				collapseButton.addEventListener('click', () => toggleGroupCollapsed(group.id));
				header.appendChild(title);
				header.appendChild(count);
				header.appendChild(addSubgroupButton);
				header.appendChild(addNoteButton);
				header.appendChild(openButton);
				header.appendChild(collapseButton);
				const body = document.createElement('div');
				body.className = 'group-body';
				if (isGroupCollapsed(group.id)) {
					body.classList.add('is-collapsed');
				}
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
					const fileId = event.dataTransfer.getData('application/x-pr-file-id');
					const textItemId = event.dataTransfer.getData('application/x-pr-text-item-id');
					if (fileId) {
						moveFileToGroup(fileId, group.id);
					} else if (textItemId) {
						moveTextItemToGroup(textItemId, group.id);
					}
				});
				if (group.fileIds.length === 0 && (!group.textItems || group.textItems.length === 0)) {
					const empty = document.createElement('div');
					empty.className = 'empty-group';
					empty.textContent = emptyGroupText;
					body.appendChild(empty);
				} else {
					const itemOrder = group.itemOrder || [];
					itemOrder.forEach(itemId => {
						if (itemId.startsWith('file-')) {
							const file = files.find(item => item.id === itemId);
							if (file) {
								const fileIndex = files.indexOf(file);
								body.appendChild(createFileElement(file, fileIndex));
							}
						} else if (itemId.startsWith('text-item-')) {
							const textItem = group.textItemsMap && group.textItemsMap[itemId];
							if (textItem) {
								const isEditing = textItem.text === '';
								body.appendChild(createTextItemElement(textItem, group, null, isEditing));
							}
						}
					});
				}
				const subgroupsContainer = document.createElement('div');
				subgroupsContainer.className = 'subgroups';
				if (!isGroupCollapsed(group.id)) {
					group.subgroups.forEach(subgroup => {
						subgroupsContainer.appendChild(createSubgroupElement(group, subgroup));
					});
				}
				container.appendChild(header);
				if (!isGroupCollapsed(group.id)) {
					container.appendChild(body);
					container.appendChild(subgroupsContainer);
				}
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
				groups.push({ id: 'group-' + groupCounter, name: name, fileIds: [], subgroups: [] });
				render();
			});

			render();
		</script>
	</body>
</html>`;
	}
}
