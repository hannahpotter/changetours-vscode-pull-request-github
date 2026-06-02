/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { AssistantMode, runAssistant } from './orchestrator';
import { CodeTourEditorProvider } from '../../github/codeTourEditorProvider';
import { parseCodeTourMarkdown } from '../../github/codeTourMarkdown';
import { RepositoriesManager } from '../../github/repositoriesManager';

const PARTICIPANT_ID = 'changeTour.assistant';
const PR_DESCRIPTION_CAP = 4000;

/**
 * Registers the `@change-tour` chat participant. Routes slash commands to the
 * orchestrator with the appropriate `AssistantMode`. Streams text events back
 * to the chat panel; write tools mutate the open Change Tour editor in place.
 */
export function registerChangeTourChatParticipant(
	context: vscode.ExtensionContext,
	reposManager: RepositoriesManager,
): vscode.Disposable {
	const handler: vscode.ChatRequestHandler = async (request, _chatContext, response, token) => {
		const mode = pickMode(request.command);
		const userPrompt = await buildUserPrompt(mode, request.prompt, reposManager);

		// Surface a friendly preface when no Change Tour editor is open - most
		// modes need one. We don't block; the orchestrator's tools will report a
		// clearer error if they actually need the document.
		if (!CodeTourEditorProvider.activeDocumentTracker && mode !== 'freeform') {
			response.markdown(vscode.l10n.t('_Tip: open a `.changetour.md` file in the Change Tour editor first - I need it as my target for changes._\n\n'));
		}

		// Bridge chat-cancellation token → AbortSignal for the orchestrator.
		const abortController = new AbortController();
		const cancelDisposable = token.onCancellationRequested(() => abortController.abort());

		const workspaceRoot = CodeTourEditorProvider.activeDocumentTracker
			? vscode.workspace.getWorkspaceFolder(CodeTourEditorProvider.activeDocumentTracker.uri)?.uri
			: vscode.workspace.workspaceFolders?.[0]?.uri;

		try {
			for await (const event of runAssistant(context, {
				mode,
				userPrompt,
				workspaceRoot,
				requestedModel: request.model,
				signal: abortController.signal,
			})) {
				switch (event.type) {
					case 'started':
						// Optional: response.progress(vscode.l10n.t('Using {0}', event.providerLabel));
						break;
					case 'text':
						response.markdown(event.text);
						break;
					case 'tool_call':
						response.progress(toolCallLabel(event.name, event.input));
						break;
					case 'tool_result':
						if (event.isError) {
							response.markdown(`\n\n> ⚠️ Tool \`${event.name}\` failed: ${event.output}\n\n`);
						}
						break;
					case 'done':
						switch (event.reason) {
							case 'cancelled':
								response.markdown(vscode.l10n.t('\n\n_Cancelled._'));
								break;
							case 'max_turns':
								response.markdown(vscode.l10n.t('\n\n_Stopped after hitting the max-agent-turns safety cap. Increase `changeTour.assistant.maxAgentTurns` if you need more._'));
								break;
							case 'error':
								response.markdown(`\n\n> ⚠️ ${event.error ?? vscode.l10n.t('Unknown error.')}\n\n`);
								break;
							case 'completed':
								// nothing to add - text events already wrote everything
								break;
						}
						break;
				}
			}
		} finally {
			cancelDisposable.dispose();
		}

		const tourUri = CodeTourEditorProvider.activeDocumentTracker?.uri;
		return tourUri ? { metadata: { tourEditorUri: tourUri.toString() } } : {};
	};

	const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
	participant.iconPath = new vscode.ThemeIcon('sparkle');
	return participant;
}

function pickMode(command: string | undefined): AssistantMode {
	switch (command) {
		case 'generate': return 'generate';
		case 'suggest': return 'suggest';
		case 'narrate': return 'narrate';
		case 'improve': return 'improve';
		case 'update': return 'update';
		default: return 'freeform';
	}
}

async function buildUserPrompt(
	mode: AssistantMode,
	rawPrompt: string,
	reposManager: RepositoriesManager,
): Promise<string> {
	const trimmed = rawPrompt.trim();
	const base = baseUserPrompt(mode, trimmed);
	// PR description is useful framing for the modes that touch the whole tour
	// or rewrite multiple hunks; the per-hunk modes (narrate, summarize, refresh)
	// don't need it. `update` joins generate/improve in this set.
	if (mode !== 'generate' && mode !== 'improve' && mode !== 'update') {
		return base;
	}
	const description = await tryGetPRDescriptionBlock(reposManager);
	return description ? `${description}\n\n${base}` : base;
}

function baseUserPrompt(mode: AssistantMode, trimmed: string): string {
	switch (mode) {
		case 'generate':
			return trimmed.length > 0
				? `Generate a complete Change Tour for the active pull request. Additional guidance from the user: ${trimmed}`
				: 'Generate a complete Change Tour for the active pull request.';
		case 'suggest':
			return trimmed.length > 0
				? `Suggest the next thing to add to this Change Tour. User context: ${trimmed}`
				: 'Suggest the next thing to add to this Change Tour.';
		case 'narrate':
			return trimmed.length > 0
				? `Draft narration for: ${trimmed}`
				: 'Draft narration for the most recently added hunk.';
		case 'improve':
			return trimmed.length > 0
				? `Polish the current Change Tour. Focus: ${trimmed}`
				: 'Polish the current Change Tour - tighten narration, add useful highlights, and surface obvious gaps.';
		case 'update':
			return trimmed.length > 0
				? `Update the current Change Tour to match the current state of the pull request. START by calling changeTour_getDriftReport - the three lists it returns are the ground truth. Process every entry, then call the report again to verify all lists are empty before stopping. Additional guidance from the user: ${trimmed}`
				: 'Update the current Change Tour to match the current state of the pull request. START by calling changeTour_getDriftReport - the three lists it returns are the ground truth. Process every entry in `drifted`, `missingInTour`, and `removedFromPR`, then call the report again to verify all three lists are empty before stopping.';
		case 'summarizeHunk':
			return trimmed.length > 0
				? `Write a one-line natural-language summary for: ${trimmed}`
				: 'Write a one-line natural-language summary for the most recently added hunk.';
		case 'refreshNarration':
			return trimmed.length > 0
				? `Refresh narration around: ${trimmed}`
				: 'Refresh the narration around the most recently auto-updated hunk.';
		case 'freeform':
		default:
			return trimmed;
	}
}

/**
 * Fetch the PR title + body for the active Change Tour's bound PR and wrap them
 * in a `<pr-description>` block the assistant can lean on for framing. Returns
 * `undefined` if there is no active tour, the PR can't be resolved, or the body
 * is empty - the prompt then falls through to the unaugmented base prompt.
 */
async function tryGetPRDescriptionBlock(reposManager: RepositoriesManager): Promise<string | undefined> {
	const document = CodeTourEditorProvider.activeDocumentTracker;
	if (!document) {
		return undefined;
	}
	try {
		const parsed = parseCodeTourMarkdown(document.getText());
		if (!parsed.prOwner || !parsed.prRepo || parsed.prNumber === undefined) {
			return undefined;
		}
		const folderManager = reposManager.getManagerForRepository(parsed.prOwner, parsed.prRepo);
		if (!folderManager) {
			return undefined;
		}
		const prModel = await folderManager.resolvePullRequest(parsed.prOwner, parsed.prRepo, parsed.prNumber);
		if (!prModel) {
			return undefined;
		}
		const title = (prModel.title ?? '').trim();
		const body = (prModel.body ?? '').trim();
		if (!title && !body) {
			return undefined;
		}
		const inner = body
			? `Title: ${title}\n\n${body}`.slice(0, PR_DESCRIPTION_CAP)
			: `Title: ${title}`;
		return `<pr-description>\n${inner}\n</pr-description>`;
	} catch {
		return undefined;
	}
}

function toolCallLabel(name: string, input: unknown): string {
	// Compact one-line label for the chat progress strip.
	switch (name) {
		case 'changeTour_getCurrentTour':
			return vscode.l10n.t('Reading current tour…');
		case 'changeTour_getAvailablePRHunks':
			return vscode.l10n.t('Reading pull request hunks…');
		case 'changeTour_addSectionToTour': {
			const title = (input as { title?: string })?.title ?? '';
			return vscode.l10n.t('Adding section "{0}"', title);
		}
		case 'changeTour_addTextNodeToTour':
			return vscode.l10n.t('Adding narration…');
		case 'changeTour_addHunkToTour': {
			const i = input as { file?: string; startLine?: number; endLine?: number };
			return vscode.l10n.t('Adding hunk {0}:{1}-{2}', i?.file ?? '?', String(i?.startLine ?? '?'), String(i?.endLine ?? '?'));
		}
		case 'changeTour_setHunkHighlights':
			return vscode.l10n.t('Updating hunk highlights…');
		case 'changeTour_removeTourNode':
			return vscode.l10n.t('Removing node…');
		default:
			return name;
	}
}
