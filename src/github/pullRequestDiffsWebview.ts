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

const VIEW_TYPE = 'PullRequestDiffs';

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

export class PullRequestDiffsWebviewPanel {
	private static readonly panels: Map<string, PullRequestDiffsWebviewPanel> = new Map();

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
			panel = new PullRequestDiffsWebviewPanel(folderRepositoryManager, pullRequestModel, activeColumn);
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
			vscode.l10n.t('Diffs - Pull Request #{0}', pullRequestModel.number.toString()),
			column,
			{
				enableFindWidget: true,
				enableScripts: true,
				retainContextWhenHidden: true,
			}
		);

		this._panel.onDidDispose(() => {
			const key = panelKey(pullRequestModel.remote.owner, pullRequestModel.remote.repositoryName, pullRequestModel.number);
			PullRequestDiffsWebviewPanel.panels.delete(key);
		});
	}

	private async update(pullRequestModel: PullRequestModel): Promise<void> {
		this._item = pullRequestModel;
		this._panel.title = vscode.l10n.t('Diffs - Pull Request #{0}', pullRequestModel.number.toString());
		this._panel.webview.html = this.getLoadingHtml();

		try {
			const files = await pullRequestModel.getRawFileChangesInfo();
			this._panel.webview.html = this.getHtmlForWebview(files);
		} catch (error) {
			Logger.error(`Failed to load diffs for PR #${pullRequestModel.number}: ${formatError(error)}`, VIEW_TYPE);
			this._panel.webview.html = this.getErrorHtml(formatError(error));
		}
	}

	private getLoadingHtml(): string {
		return `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<title>${vscode.l10n.t('Diffs')}</title>
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
		<div>${vscode.l10n.t('Loading diffs...')}</div>
	</body>
</html>`;
	}

	private getErrorHtml(message: string): string {
		return `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<title>${vscode.l10n.t('Diffs')}</title>
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
		const diffItems = files
			.filter(file => file.patch) // Only include files with diff content
			.map((file, index) => {
				const hunks = parsePatch(file.patch || '');
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
					id: `diff-${index}`,
					fileName: file.filename,
					label: formatFileLabel(file),
					status: file.status,
					additions: file.additions,
					deletions: file.deletions,
					hunks: hunkItems,
				};
			});

		const totalText = vscode.l10n.t('{0} files with diffs', diffItems.length.toString());
		const noDiffText = vscode.l10n.t('No diffs available');

		return `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<title>${vscode.l10n.t('Diffs')}</title>
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
			.diffs {
				display: grid;
				gap: 12px;
			}
			.diff-file {
				border: 1px solid var(--vscode-editorWidget-border);
				border-radius: 6px;
				padding: 8px;
				background: var(--vscode-editorWidget-background);
			}
			.diff-header {
				display: flex;
				align-items: center;
				justify-content: space-between;
				margin-bottom: 8px;
				gap: 8px;
				flex-wrap: wrap;
			}
			.diff-filename {
				font-size: 13px;
				font-weight: 600;
				color: inherit;
				flex: 1;
				min-width: 200px;
			}
			.diff-file-status {
				font-weight: 600;
				font-size: 11px;
				text-transform: uppercase;
				white-space: nowrap;
			}
			.diff-file-count {
				white-space: nowrap;
				font-size: 11px;
				color: var(--vscode-descriptionForeground);
			}
			.diff-body {
				background: var(--vscode-editor-background);
				border: 1px solid var(--vscode-input-border, transparent);
				border-radius: 4px;
				padding: 0;
				overflow-x: auto;
				max-height: 400px;
				overflow-y: auto;
			}
			.diff-body.is-collapsed {
				display: none;
			}
			.hunks {
				display: grid;
				gap: 12px;
				padding: 8px 0;
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
			.diff-content {
				font-family: var(--vscode-editor-font-family);
				font-size: 12px;
				line-height: 1.5;
				white-space: pre-wrap;
				word-wrap: break-word;
				margin: 0;
				padding: 12px;
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
			.no-diffs {
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
			<h1>${vscode.l10n.t('Diffs')}</h1>
		</div>
		<div class="summary">${escapeHtml(totalText)}</div>
		<div id="diffs" class="diffs" aria-label="${vscode.l10n.t('Diff files')}"></div>
		<script nonce="${nonce}">
			const diffs = ${serializeForScript(diffItems)};
			const noDiffText = ${serializeForScript(noDiffText)};
			const collapseLabel = ${serializeForScript(vscode.l10n.t('Collapse'))};
			const expandLabel = ${serializeForScript(vscode.l10n.t('Expand'))};
			const diffsRoot = document.getElementById('diffs');
			const collapsedDiffs = new Set();
			let draggedHunk = null;
			let draggedFromFileIndex = null;
			let draggedFromHunkIndex = null;

			// Type constants matching DiffChangeType from diffHunk.ts
			const DiffChangeType = {
				Context: 0,
				Add: 1,
				Delete: 2,
				Control: 3,
			};

			function isDiffCollapsed(diffId) {
				return collapsedDiffs.has(diffId);
			}

			function toggleDiffCollapsed(diffId) {
				if (collapsedDiffs.has(diffId)) {
					collapsedDiffs.delete(diffId);
				} else {
					collapsedDiffs.add(diffId);
				}
				render();
			}

			function createHunkElement(hunk, fileIndex, hunkIndex) {
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
						const hunks = diffs[fileIndex].hunks;
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

			function createDiffElement(diff, fileIndex) {
				const container = document.createElement('section');
				container.className = 'diff-file';
				container.dataset.diffId = diff.id;

				const header = document.createElement('div');
				header.className = 'diff-header';

				const filename = document.createElement('div');
				filename.className = 'diff-filename';
				filename.textContent = diff.label;

				const status = document.createElement('div');
				status.className = 'diff-file-status status-' + diff.status;
				status.textContent = diff.status.toUpperCase();

				const additions = document.createElement('div');
				additions.className = 'diff-file-count status-' + diff.status;
				additions.textContent = '+' + diff.additions;

				const deletions = document.createElement('div');
				deletions.className = 'diff-file-count status-' + diff.status;
				deletions.textContent = '-' + diff.deletions;

				const collapseButton = document.createElement('button');
				collapseButton.type = 'button';
				collapseButton.textContent = isDiffCollapsed(diff.id) ? expandLabel : collapseLabel;
				collapseButton.addEventListener('click', () => toggleDiffCollapsed(diff.id));

				header.appendChild(filename);
				header.appendChild(status);
				header.appendChild(additions);
				header.appendChild(deletions);
				header.appendChild(collapseButton);

				const body = document.createElement('div');
				body.className = 'diff-body';
				if (isDiffCollapsed(diff.id)) {
					body.classList.add('is-collapsed');
				}

				const hunksContainer = document.createElement('div');
				hunksContainer.className = 'hunks';

				for (let hunkIndex = 0; hunkIndex < diff.hunks.length; hunkIndex++) {
					const hunk = diff.hunks[hunkIndex];
					hunksContainer.appendChild(createHunkElement(hunk, fileIndex, hunkIndex));
				}

				body.appendChild(hunksContainer);
				container.appendChild(header);
				container.appendChild(body);

				return container;
			}

			function render() {
				diffsRoot.innerHTML = '';
				if (diffs.length === 0) {
					const empty = document.createElement('div');
					empty.className = 'no-diffs';
					empty.textContent = noDiffText;
					diffsRoot.appendChild(empty);
					return;
				}
				diffs.forEach((diff, fileIndex) => {
					diffsRoot.appendChild(createDiffElement(diff, fileIndex));
				});
			}

			render();
		</script>
	</body>
</html>`;
	}
}
