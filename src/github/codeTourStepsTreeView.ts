/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CodeTourEditorProvider } from './codeTourEditorProvider';
import { parseCodeTourMarkdown, TourGroupNode, TourNode } from './codeTourMarkdown';

export class CodeTourStepsTreeView implements vscode.TreeDataProvider<TourGroupNode> {
	private _onDidChangeTreeData = new vscode.EventEmitter<TourGroupNode | undefined | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private currentDocument: vscode.TextDocument | undefined;
	private currentTourNodes: TourGroupNode[] = [];

	constructor() {
		CodeTourEditorProvider.onDidChangeActiveCodeTour.event((document) => {
			this.currentDocument = document;
			this.refresh();
		});

		vscode.workspace.onDidChangeTextDocument(e => {
			if (this.currentDocument && e.document.uri.toString() === this.currentDocument.uri.toString()) {
				this.refresh();
			}
		});

		this.currentDocument = CodeTourEditorProvider.activeDocumentTracker;
		this.refresh();
	}

	refresh(): void {
		if (this.currentDocument) {
			const text = this.currentDocument.getText();
			const doc = parseCodeTourMarkdown(text);
			// Extract all group nodes
			const extractGroups = (nodes: TourNode[]): TourGroupNode[] => {
				const groups: TourGroupNode[] = [];
				for (const node of nodes) {
					if (node.type === 'group') {
						groups.push(node);
					}
				}
				return groups;
			};
			this.currentTourNodes = extractGroups(doc.children);
		} else {
			this.currentTourNodes = [];
		}
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: TourGroupNode): vscode.TreeItem {
		const item = new vscode.TreeItem(element.title, element.children.some(c => c.type === 'group') ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
		if (this.currentDocument) {
			item.command = {
				command: 'codetour.scrollToSection',
				title: 'Scroll to Section',
				arguments: [this.currentDocument.uri, element.id]
			};
		}
		return item;
	}

	getChildren(element?: TourGroupNode): vscode.ProviderResult<TourGroupNode[]> {
		if (!element) {
			return this.currentTourNodes;
		}

		const groups: TourGroupNode[] = [];
		for (const node of element.children) {
			if (node.type === 'group') {
				groups.push(node);
			}
		}
		return groups;
	}
}
