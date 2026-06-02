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
 *   - `pr.editTourWithClaudeCode` - ensures the project-scoped Claude Code skill
 *     at `<repoRoot>/.claude/skills/change-tour/SKILL.md` is installed, then
 *     opens a terminal with a short `claude` invocation that triggers the skill.
 *     The skill body has the full format contract + bootstrap recipe so users
 *     can also run the same command from any shell outside VS Code.
 *   - `pr.updateTourWithClaudeCode` - same setup, but seeds the terminal with
 *     an "update this tour to match the PR's current state" prompt instead of
 *     the open-ended edit prompt. Surfaced from the outdated-tour banner and
 *     the `.changetour.md` editor title menu.
 *   - `pr.setAnthropicApiKey` - stores an Anthropic API key in SecretStorage
 *     for the AnthropicProvider fallback.
 */
export function registerExternalIntegrationCommands(context: vscode.ExtensionContext): void {
	const registerClaudeCommand = (commandId: string, framing: 'edit' | 'update') => {
		context.subscriptions.push(
			vscode.commands.registerCommand(commandId, async (uri?: vscode.Uri) => {
				const tourUri = pickTourUri(uri);
				const workspaceRoot = resolveWorkspaceRoot(tourUri);
				if (!workspaceRoot) {
					vscode.window.showErrorMessage(vscode.l10n.t('Open a workspace folder first - the Claude Code skill installs into the repo at .claude/skills/change-tour.'));
					return;
				}

				try {
					await ensureSkillInstalled(context, workspaceRoot);
				} catch (err) {
					vscode.window.showErrorMessage(vscode.l10n.t('Could not install the change-tour Claude Code skill: {0}', err instanceof Error ? err.message : String(err)));
					return;
				}

				const terminal = vscode.window.createTerminal({ name: 'Claude Code · Change Tour' });
				const command = buildClaudeCommand(tourUri, framing);
				// `false` (no newline) lets the user review/edit the prompt before pressing Enter.
				terminal.sendText(command, false);
				terminal.show();
			}),
		);
	};
	registerClaudeCommand('pr.editTourWithClaudeCode', 'edit');
	registerClaudeCommand('pr.updateTourWithClaudeCode', 'update');

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
 * Install the change-tour skill into `<workspaceRoot>/.claude/skills/change-tour/`.
 * Two files land there:
 *   - SKILL.md             - the prompt body. User-editable. We only write it if
 *                            it is missing; existing files are left alone so a
 *                            user's customizations survive future upgrades.
 *   - validate-change-tour.js - the bundled validator. Not user-editable - we
 *                            always overwrite it so it stays in sync with the
 *                            extension that produced the format the skill writes.
 */
async function ensureSkillInstalled(context: vscode.ExtensionContext, workspaceRoot: vscode.Uri): Promise<void> {
	const skillDir = vscode.Uri.joinPath(workspaceRoot, '.claude', 'skills', 'change-tour');
	await vscode.workspace.fs.createDirectory(skillDir);

	const skillFile = vscode.Uri.joinPath(skillDir, 'SKILL.md');
	let installedSkill = false;
	try {
		await vscode.workspace.fs.stat(skillFile);
	} catch {
		const templatePath = path.join(context.extensionPath, 'resources', 'changeTour', 'claudeSkillTemplate.md');
		const template = await vscode.workspace.fs.readFile(vscode.Uri.file(templatePath));
		await vscode.workspace.fs.writeFile(skillFile, template);
		installedSkill = true;
	}

	// Always copy the validator + drift report alongside the skill so the
	// scripts are runnable from any shell, even outside the extension's own
	// repo. Overwriting is safe - these are tools, not prompts, and users
	// shouldn't be editing them. The drift report is what gives Claude CLI
	// the same ground-truth signal the in-extension `changeTour_getDriftReport`
	// tool gives the in-extension assistant.
	const copyScript = async (basename: string) => {
		const src = path.join(context.extensionPath, 'scripts', basename);
		const dest = vscode.Uri.joinPath(skillDir, basename);
		const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(src));
		await vscode.workspace.fs.writeFile(dest, bytes);
	};
	await copyScript('validate-change-tour.js');
	await copyScript('drift-report-change-tour.js');

	if (installedSkill) {
		vscode.window.showInformationMessage(vscode.l10n.t('Installed Claude Code skill at .claude/skills/change-tour/.'));
	}
}

function buildClaudeCommand(tourUri: vscode.Uri | undefined, framing: 'edit' | 'update'): string {
	if (!tourUri) {
		// No active tour - bootstrap is the only sensible action regardless of framing.
		return `claude "Use the change-tour skill to bootstrap a new change tour for the current pull request"`;
	}
	const relPath = vscode.workspace.asRelativePath(tourUri);
	if (framing === 'update') {
		return `claude "Use the change-tour skill to update @${relPath} to match the current state of the pull request. START by running the bundled drift report (node .claude/skills/change-tour/drift-report-change-tour.js @${relPath} --json) - the three lists it returns are the ground truth for what needs to change. Process every entry in drifted, missingInTour, and removedFromPR. When done, run the report again to verify all three lists are empty before stopping."`;
	}
	return `claude "Use the change-tour skill to edit @${relPath}"`;
}

function resolveWorkspaceRoot(tourUri: vscode.Uri | undefined): vscode.Uri | undefined {
	if (tourUri) {
		const folder = vscode.workspace.getWorkspaceFolder(tourUri);
		if (folder) {
			return folder.uri;
		}
	}
	return vscode.workspace.workspaceFolders?.[0]?.uri;
}

function pickTourUri(passed?: vscode.Uri): vscode.Uri | undefined {
	if (passed && passed.fsPath.endsWith('.changetour.md')) {
		return passed;
	}
	const activeTour = CodeTourEditorProvider.activeDocumentTracker;
	if (activeTour) {
		return activeTour.uri;
	}
	const activeEditor = vscode.window.activeTextEditor;
	if (activeEditor && activeEditor.document.uri.fsPath.endsWith('.changetour.md')) {
		return activeEditor.document.uri;
	}
	return undefined;
}
