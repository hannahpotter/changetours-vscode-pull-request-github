/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CodeTourEditorProvider } from './codeTourEditorProvider';
import { CodeTourDocument, parseCodeTourMarkdown, serializeCodeTourMarkdown, TourGroupNode, TourHunkNode, TourNode } from './codeTourMarkdown';
import { extractNodeById, moveNodeRelative, moveNodeToGroupEnd, normalizeGroupLevels } from './codeTourTreeHelpers';
import { RepositoriesManager } from './repositoriesManager';

export class CodeTourStepsTreeView implements vscode.TreeDataProvider<TourGroupNode | TourHunkNode | CodeTourDocument>, vscode.Disposable {
	private _onDidChangeTreeData = new vscode.EventEmitter<TourGroupNode | TourHunkNode | CodeTourDocument | undefined | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private currentDocument: vscode.TextDocument | undefined;
	private parsedDoc: CodeTourDocument | undefined;
	private currentTourNodes: (TourGroupNode | TourHunkNode)[] = [];
	private _view: vscode.TreeView<TourGroupNode | TourHunkNode | CodeTourDocument> | undefined;
	private _disposables: vscode.Disposable[] = [];

	private get isPRCheckedOut(): boolean {
		if (!this.parsedDoc || !this.currentDocument) {
			return false;
		}
		const doc = this.parsedDoc;
		if (doc.isPR && doc.prNumber && doc.prOwner && doc.prRepo) {
			const folderManager = this._reposManager.getManagerForFile(this.currentDocument.uri) ?? this._reposManager.folderManagers[0];
			if (folderManager) {
				const activePR = folderManager.activePullRequest;
				return !!(activePR && activePR.number === doc.prNumber &&
					activePR.remote.owner.toLowerCase() === doc.prOwner.toLowerCase() &&
					activePR.remote.repositoryName.toLowerCase() === doc.prRepo.toLowerCase());
			}
		}
		return false;
	}

	constructor(private _reposManager: RepositoriesManager) {
		this._view = vscode.window.createTreeView('codetour:steps', {
			treeDataProvider: this,
			showCollapseAll: true,
			dragAndDropController: new CodeTourStepsTreeDragAndDropController(this)
		});
		this._disposables.push(this._view);

		this._disposables.push(CodeTourEditorProvider.onDidChangeActiveCodeTour.event((document) => {
			this.currentDocument = document;
			this.refresh();
		}));

		this._disposables.push(vscode.workspace.onDidChangeTextDocument(e => {
			if (this.currentDocument && e.document.uri.toString() === this.currentDocument.uri.toString()) {
				this.refresh();
			}
		}));

		this.currentDocument = CodeTourEditorProvider.activeDocumentTracker;
		this.refresh();
	}

	dispose() {
		this._disposables.forEach(d => d.dispose());
	}

	public static currentPRParams: { prNumber: number, prOwner: string, prRepo: string } | undefined = undefined;

	private updateViewTitle(): void {
		if (this._view) {
			const doc = this.parsedDoc;

			if (doc && doc.isPR && doc.prNumber) {
				CodeTourStepsTreeView.currentPRParams = {
					prNumber: doc.prNumber!,
					prOwner: doc.prOwner!,
					prRepo: doc.prRepo!
				};

				this._view.title = vscode.l10n.t('Code Tour: Pull Request #{0}', doc.prNumber);
				vscode.commands.executeCommand('setContext', 'codetour:checkoutAvailable', !this.isPRCheckedOut);
			} else {
				CodeTourStepsTreeView.currentPRParams = undefined;
				this._view.title = vscode.l10n.t('Code Tour Steps');
				vscode.commands.executeCommand('setContext', 'codetour:checkoutAvailable', false);
			}
		}
	}

	refresh(): void {
		if (this.currentDocument) {
			const text = this.currentDocument.getText();
			const doc = parseCodeTourMarkdown(text);
			// Extract all group and hunk nodes
			const extractGroupsAndHunks = (nodes: TourNode[]): (TourGroupNode | TourHunkNode)[] => {
				const result: (TourGroupNode | TourHunkNode)[] = [];
				for (const node of nodes) {
					if (node.type === 'group' || node.type === 'hunk') {
						result.push(node);
					}
				}
				return result;
			};
			this.parsedDoc = doc;
			this.currentTourNodes = extractGroupsAndHunks(doc.children);
		} else {
			this.parsedDoc = undefined;
			this.currentTourNodes = [];
		}
		this.updateViewTitle();
		this._onDidChangeTreeData.fire();
	}

	public getCurrentDocument(): CodeTourDocument | undefined {
		return this.parsedDoc;
	}

	public getCurrentTextDocument(): vscode.TextDocument | undefined {
		return this.currentDocument;
	}

	getTreeItem(element: TourGroupNode | TourHunkNode | CodeTourDocument): vscode.TreeItem {
		if ((element as CodeTourDocument).isPR !== undefined || !((element as TourNode).type)) {
			// This is a CodeTourDocument
			const doc = element as CodeTourDocument;
			const item = new vscode.TreeItem(doc.title, vscode.TreeItemCollapsibleState.Expanded);

			item.contextValue = this.isPRCheckedOut ? 'codetourDocumentCheckedOut' : 'codetourDocumentNotCheckedOut';
			return item;
		}

		if ((element as TourNode).type === 'hunk') {
			const hunkElement = element as TourHunkNode;
			// e.g. src/myFile.ts L10-20
			const label = `${hunkElement.hunk.file} L${hunkElement.hunk.startLine}-${hunkElement.hunk.endLine}`;
			const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
			item.iconPath = new vscode.ThemeIcon('diff');
			item.contextValue = this.isPRCheckedOut ? 'codetourHunkCheckedOut' : 'codetourHunkNotCheckedOut';

			// Attach PR info to the hunk so `codetour.openDiff` can associate it with an active PR diff
			if (this.parsedDoc) {
				const hunkPayload = hunkElement.hunk as unknown as { isPR?: boolean; prNumber?: string; prOwner?: string; prRepo?: string };
				hunkPayload.isPR = this.parsedDoc.isPR;
				hunkPayload.prNumber = String(this.parsedDoc.prNumber);
				hunkPayload.prOwner = this.parsedDoc.prOwner;
				hunkPayload.prRepo = this.parsedDoc.prRepo;
			}

			// Pass the original `hunk` reference since codetour.openDiff takes it
			item.command = {
				command: 'codetour.scrollToSection',
				title: 'Scroll to Section',
				arguments: [this.currentDocument!.uri, hunkElement.id]
			};
			return item;
		}

		const groupElement = element as TourGroupNode;
		const item = new vscode.TreeItem(groupElement.title, groupElement.children.some(c => c.type === 'group' || c.type === 'hunk') ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
		item.contextValue = 'codetourGroup';
		if (this.currentDocument) {
			item.command = {
				command: 'codetour.scrollToSection',
				title: 'Scroll to Section',
				arguments: [this.currentDocument.uri, groupElement.id]
			};
		}
		return item;
	}

	getChildren(element?: TourGroupNode | TourHunkNode | CodeTourDocument): vscode.ProviderResult<(TourGroupNode | TourHunkNode | CodeTourDocument)[]> {
		if (!element) {
			if (this.parsedDoc) {
				return [this.parsedDoc];
			}
			return [];
		}

		if ((element as CodeTourDocument).isPR !== undefined || !((element as TourNode).type)) {
			// It's the root Document node
			return this.currentTourNodes;
		}

		const nodeElement = element as TourNode;
		if (nodeElement.type === 'hunk') {
			return [];
		}

		const result: (TourGroupNode | TourHunkNode)[] = [];
		for (const node of (nodeElement as TourGroupNode).children) {
			if (node.type === 'group' || node.type === 'hunk') {
				result.push(node);
			}
		}
		return result;
	}
}

class CodeTourStepsTreeDragAndDropController implements vscode.TreeDragAndDropController<TourGroupNode | TourHunkNode | CodeTourDocument> {
	dropMimeTypes = ['application/vnd.code.tree.codetoursteps'];
	dragMimeTypes = ['application/vnd.code.tree.codetoursteps'];

	constructor(private treeProvider: CodeTourStepsTreeView) { }

	async handleDrag(source: (TourGroupNode | TourHunkNode | CodeTourDocument)[], dataTransfer: vscode.DataTransfer, _token: vscode.CancellationToken): Promise<void> {
		if (source.length === 0) {
			return;
		}

		// Use the first selected node's ID for dragging (we only support single drag properly)
		const sourceNode = source[0] as TourNode;
		if (!sourceNode || !sourceNode.id) {
			return;
		}

		const nodeIds = [sourceNode.id];
		dataTransfer.set(this.dropMimeTypes[0], new vscode.DataTransferItem(JSON.stringify(nodeIds)));
	}

	async handleDrop(target: TourGroupNode | TourHunkNode | CodeTourDocument | undefined, dataTransfer: vscode.DataTransfer, _token: vscode.CancellationToken): Promise<void> {
		const draggedDataItem = dataTransfer.get(this.dropMimeTypes[0]);
		if (!draggedDataItem) {
			return;
		}

		const draggedIds = JSON.parse(await draggedDataItem.asString());
		if (!draggedIds || draggedIds.length === 0) {
			return;
		}

		const sourceId = draggedIds[0];
		const parsedDoc = this.treeProvider.getCurrentDocument();
		const textDocument = this.treeProvider.getCurrentTextDocument();

		if (!parsedDoc || !textDocument) {
			return;
		}

		let newChildren: TourNode[] = [...parsedDoc.children];

		if (!target || !(target as TourNode).type) {
			// Dropped on the root document. Move after the very last element of the tree
			const { nodes, extracted } = extractNodeById(newChildren, sourceId);
			if (extracted) {
				newChildren = [...nodes, extracted];
			}
		} else {
			const targetNode = target as TourNode;

			if (targetNode.type === 'group') {
				// Dropped onto a group: append to the end of that group
				newChildren = moveNodeToGroupEnd(newChildren, sourceId, targetNode.id);
			} else {
				// Dropped onto a hunk
				newChildren = moveNodeRelative(newChildren, sourceId, targetNode.id, 'after');
			}
		}

		newChildren = normalizeGroupLevels(newChildren);

		const modifiedDoc: CodeTourDocument = {
			...parsedDoc,
			children: newChildren
		};

		const newMarkdown = serializeCodeTourMarkdown(modifiedDoc);

		const edit = new vscode.WorkspaceEdit();
		edit.replace(
			textDocument.uri,
			new vscode.Range(0, 0, textDocument.lineCount, 0),
			newMarkdown
		);
		await vscode.workspace.applyEdit(edit);
	}
}
