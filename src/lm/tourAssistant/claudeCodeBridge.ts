/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as path from 'path';
import * as vscode from 'vscode';
import { ANTHROPIC_API_KEY_SECRET } from './provider';
import { CodeTourEditorProvider } from '../../github/codeTourEditorProvider';

/**
 * Registers commands related to external assistant integrations:
 *   - `pr.editTourWithClaudeCode` - opens the workspace terminal with a
 *     prefilled `claude` CLI invocation so users can drive Claude Code
 *     externally to edit the current Change Tour.
 *   - `pr.setAnthropicApiKey` - stores an Anthropic API key in SecretStorage
 *     for the AnthropicProvider fallback.
 */
export function registerExternalIntegrationCommands(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('pr.editTourWithClaudeCode', async (uri?: vscode.Uri) => {
			const tourUri = pickTourUri(uri);
			if (!tourUri) {
				vscode.window.showErrorMessage(vscode.l10n.t('Open a Change Tour file first.'));
				return;
			}
			const relPath = vscode.workspace.asRelativePath(tourUri);
			// Bundle path → absolute path so the validator works regardless of the workspace's cwd.
			const validatorPath = path.join(context.extensionPath, 'scripts', 'validate-change-tour.js');
			const prompt = buildClaudeCodePrompt(relPath, validatorPath);

			const terminal = vscode.window.createTerminal({ name: 'Claude Code · Change Tour' });
			// `false` (no newline) lets the user review/edit the prompt before pressing Enter.
			terminal.sendText(`claude ${shellQuote(prompt)}`, false);
			terminal.show();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('pr.setAnthropicApiKey', async () => {
			const existing = await context.secrets.get(ANTHROPIC_API_KEY_SECRET);
			const action = existing
				? await vscode.window.showQuickPick(
					[
						{ label: vscode.l10n.t('Replace existing key'), id: 'replace' },
						{ label: vscode.l10n.t('Remove stored key'), id: 'remove' },
						{ label: vscode.l10n.t('Cancel'), id: 'cancel' },
					],
					{ placeHolder: vscode.l10n.t('An Anthropic API key is already stored.') },
				)
				: { id: 'replace' as const };

			if (!action || action.id === 'cancel') {
				return;
			}
			if (action.id === 'remove') {
				await context.secrets.delete(ANTHROPIC_API_KEY_SECRET);
				vscode.window.showInformationMessage(vscode.l10n.t('Anthropic API key removed.'));
				return;
			}

			const key = await vscode.window.showInputBox({
				placeHolder: 'sk-ant-…',
				prompt: vscode.l10n.t('Paste your Anthropic API key. It is stored in VS Code SecretStorage and only used when the Change Tour assistant falls back to direct Anthropic API calls.'),
				password: true,
				ignoreFocusOut: true,
				validateInput: v => v && v.startsWith('sk-ant-') ? undefined : vscode.l10n.t('Anthropic keys start with "sk-ant-".'),
			});
			if (!key) {
				return;
			}
			await context.secrets.store(ANTHROPIC_API_KEY_SECRET, key);
			vscode.window.showInformationMessage(vscode.l10n.t('Anthropic API key stored.'));
		}),
	);
}

/**
 * Build the prefilled prompt for Claude Code. Includes:
 *  - the Change Tour format contract (frontmatter + hunk shape) so Claude Code
 *    knows what "valid" means without us shipping a separate spec doc
 *  - an instruction to run the bundled validator after each significant edit
 *    and fix any reported errors - this is the same validity gate the
 *    in-extension LLM tools enforce, expressed as an external checker
 */
function buildClaudeCodePrompt(relPath: string, validatorPath: string): string {
	return [
		`Edit the Change Tour file @${relPath} to improve it.`,
		'',
		'A Change Tour (.codetour.md) is a guided walkthrough of a pull request. It MUST be a valid document with this exact shape:',
		'',
		'1. Frontmatter (required, must be the first lines of the file):',
		'   ---',
		'   isPR: true',
		'   prNumber: <integer>',
		'   prOwner: <github owner>',
		'   prRepo: <github repo>',
		'   baseRef: <base branch>',
		'   ---',
		'',
		'2. A single H1 title (# …).',
		'',
		'3. An ordered tree of three node kinds:',
		'   - group: a markdown heading ## through ###### that groups related nodes',
		'   - text: a paragraph of narration (1-3 sentences explaining the WHY of nearby changes)',
		'   - hunk: a fenced block referencing one diff hunk from the bound pull request:',
		'       :::hunk file=<repo/relative/path> lines=<startLine>-<endLine> ref=<ref-or-HEAD> [previousFile=<old/path>] [highlights=new:14-18,old:22-25]',
		'       <full raw patch starting with the @@ -A,B +C,D @@ header>',
		'       :::',
		'',
		'   Every hunk MUST have a body (the raw patch text) between the opening :::hunk … line and the closing ::: line. The body MUST begin with an @@ -A,B +C,D @@ header. Use `ref=HEAD` unless you have a specific commit SHA.',
		'',
		'After EVERY significant edit, run the bundled validator and fix any errors it reports before moving on:',
		'',
		`    node ${shellQuote(validatorPath)} ${shellQuote(relPath)}`,
		'',
		'The validator catches missing frontmatter, malformed hunk directives, missing patch bodies, and bad highlight syntax. If the `gh` CLI is installed and authenticated, it ALSO cross-checks every hunk against the live pull request diff (via `gh pr diff`) and rejects hunks whose file path or line range does not match a real hunk in the PR - its error messages list the available ranges so you can correct them. Pass `--skip-pr-check` if you want to skip the live diff cross-check (e.g. while working offline). If the validator exits 0, the tour is valid.',
		'',
		'Write good narration (focus on WHY, not WHAT - the diff already shows what). Group related changes under descriptive section headings. Skip noise (whitespace-only changes, generated files, trivial reformats).',
	].join('\n');
}

/**
 * Quote a string for safe inclusion in a POSIX shell command. We embed it
 * in a `claude "<prompt>"` call, so double-quotes inside the prompt are the
 * main hazard.
 */
function shellQuote(s: string): string {
	// Use single quotes; escape any single quotes by closing, escaping, reopening.
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

function pickTourUri(passed?: vscode.Uri): vscode.Uri | undefined {
	if (passed && passed.fsPath.endsWith('.codetour.md')) {
		return passed;
	}
	const activeTour = CodeTourEditorProvider.activeDocumentTracker;
	if (activeTour) {
		return activeTour.uri;
	}
	const activeEditor = vscode.window.activeTextEditor;
	if (activeEditor && activeEditor.document.uri.fsPath.endsWith('.codetour.md')) {
		return activeEditor.document.uri;
	}
	return undefined;
}
