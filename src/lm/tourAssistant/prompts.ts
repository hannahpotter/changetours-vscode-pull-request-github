/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as path from 'path';
import * as vscode from 'vscode';
import { CHANGE_TOUR_DIRNAME } from '../../github/codeTourFileLocator';

/**
 * Build the system prompt for a given assistant mode. The prompt is assembled
 * from markdown files shipped under <extensionPath>/resources/changeTour/defaultInstructions/.
 * Per-workspace customizations layer in via a single optional file:
 *   <workspaceRoot>/.changetours/custom-instructions.md
 * If present, its contents are appended (after a separator) to every mode's
 * default prompt so users can add house rules without forking the defaults.
 */

export type AssistantMode = 'generate' | 'suggest' | 'narrate' | 'improve' | 'freeform';

const CUSTOM_INSTRUCTIONS_FILENAME = 'custom-instructions.md';
const SEPARATOR = '\n\n--- User-provided instructions ---\n\n';

export async function getSystemPrompt(
	extensionPath: string,
	mode: AssistantMode,
	workspaceRoot?: vscode.Uri,
): Promise<string> {
	const baseDir = path.join(extensionPath, 'resources', 'changeTour', 'defaultInstructions');
	const preamble = await readMarkdown(path.join(baseDir, 'common-preamble.md'));
	const modeBody = await readMarkdown(path.join(baseDir, `${mode}.md`));
	let prompt = `${preamble}\n\n${modeBody}`;

	if (workspaceRoot) {
		const overrideUri = vscode.Uri.joinPath(workspaceRoot, CHANGE_TOUR_DIRNAME, CUSTOM_INSTRUCTIONS_FILENAME);
		const override = await readWorkspaceFile(overrideUri);
		if (override && override.trim().length > 0) {
			prompt += SEPARATOR + override.trim();
		}
	}

	return prompt;
}

async function readMarkdown(filePath: string): Promise<string> {
	const data = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
	return new TextDecoder().decode(data).trimEnd();
}

async function readWorkspaceFile(uri: vscode.Uri): Promise<string | undefined> {
	try {
		const data = await vscode.workspace.fs.readFile(uri);
		return new TextDecoder().decode(data);
	} catch {
		return undefined;
	}
}
