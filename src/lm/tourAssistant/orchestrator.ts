/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { getSystemPrompt } from './prompts';
import { ChatContentBlock, ChatMessage, resolveProvider, TourAssistantProvider } from './provider';
import { getTourAssistantToolSpecs } from './tools';

export type AssistantMode = 'generate' | 'suggest' | 'narrate' | 'improve' | 'freeform';

export interface OrchestratorRunArgs {
	mode: AssistantMode;
	/** User-supplied prompt (free-form text). For modes like /narrate the participant prefills hunk context here. */
	userPrompt: string;
	/** Optional: pre-resolved chat model from the chat participant request. Bypasses provider selection. */
	requestedModel?: vscode.LanguageModelChat;
	/** Abort signal - wire this to the UI's stop button. */
	signal: AbortSignal;
	/** Soft cap on agent loop turns. Default from settings. */
	maxTurns?: number;
}

export type OrchestratorEvent =
	| { type: 'started'; providerLabel: string }
	| { type: 'text'; text: string }
	| { type: 'tool_call'; id: string; name: string; input: unknown }
	| { type: 'tool_result'; id: string; name: string; output: string; isError: boolean }
	| { type: 'done'; reason: 'completed' | 'cancelled' | 'max_turns' | 'error'; error?: string };

const SETTINGS_NAMESPACE = 'changeTour.assistant';

/**
 * Drives the agent loop. Each turn:
 *   1. Send messages → provider.streamChat
 *   2. Forward text deltas to the caller as `text` events
 *   3. Collect tool calls; when the model stops with `tool_use`, execute each
 *      tool via vscode.lm.invokeTool, append the result as a `user`/tool_result
 *      block, and loop.
 *   4. When the model stops with `end_turn` (or another terminal reason), emit
 *      `done` and exit.
 *
 * The loop has a hard cap (default 25) so a runaway model can't spin forever.
 */
export async function* runAssistant(
	context: vscode.ExtensionContext,
	args: OrchestratorRunArgs,
): AsyncIterable<OrchestratorEvent> {
	const cfg = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE);
	const maxTurns = args.maxTurns ?? cfg.get<number>('maxAgentTurns', 25);

	let provider: TourAssistantProvider;
	try {
		provider = await resolveProvider({ context, requestedModel: args.requestedModel });
	} catch (err) {
		yield { type: 'done', reason: 'error', error: err instanceof Error ? err.message : String(err) };
		return;
	}

	yield { type: 'started', providerLabel: provider.label };

	const system = getSystemPrompt(args.mode);
	const tools = getTourAssistantToolSpecs();

	const messages: ChatMessage[] = [
		{ role: 'user', content: args.userPrompt },
	];

	for (let turn = 0; turn < maxTurns; turn++) {
		if (args.signal.aborted) {
			yield { type: 'done', reason: 'cancelled' };
			return;
		}

		// Accumulate assistant turn content as we stream.
		const assistantBlocks: ChatContentBlock[] = [];
		// Track tool calls by id; populated from tool_use_start (name) and tool_use_end (input).
		// Preserve emission order via `order[]` so we execute calls in the order the model produced them.
		const toolCallMap = new Map<string, { name: string; input?: unknown }>();
		const toolCallOrder: string[] = [];
		let textBuffer = '';
		let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'cancelled' | 'error' = 'end_turn';
		let streamError: string | undefined;

		try {
			for await (const event of provider.streamChat({
				system,
				messages,
				tools,
				signal: args.signal,
			})) {
				switch (event.type) {
					case 'text_delta':
						textBuffer += event.text;
						yield { type: 'text', text: event.text };
						break;
					case 'tool_use_start':
						// Flush any pending text into the assistant block before the tool_use block.
						if (textBuffer.length > 0) {
							assistantBlocks.push({ type: 'text', text: textBuffer });
							textBuffer = '';
						}
						toolCallMap.set(event.id, { name: event.name });
						toolCallOrder.push(event.id);
						break;
					case 'tool_use_end': {
						const entry = toolCallMap.get(event.id);
						if (entry) {
							entry.input = event.input;
						} else {
							// Provider emitted end without start (shouldn't happen but be defensive).
							toolCallMap.set(event.id, { name: '', input: event.input });
							toolCallOrder.push(event.id);
						}
						break;
					}
					case 'message_end':
						stopReason = event.stopReason;
						streamError = event.error;
						break;
				}
				// `tool_use_input_delta` events are debug-only here; we don't surface them.
			}
		} catch (err) {
			yield { type: 'done', reason: 'error', error: err instanceof Error ? err.message : String(err) };
			return;
		}

		if (textBuffer.length > 0) {
			assistantBlocks.push({ type: 'text', text: textBuffer });
		}

		const pendingToolCalls = toolCallOrder
			.map(id => {
				const entry = toolCallMap.get(id)!;
				return { id, name: entry.name, input: entry.input ?? {} };
			})
			.filter(c => c.name.length > 0);

		if (stopReason === 'cancelled' || args.signal.aborted) {
			yield { type: 'done', reason: 'cancelled' };
			return;
		}
		if (stopReason === 'error') {
			yield { type: 'done', reason: 'error', error: streamError };
			return;
		}

		// Append the assistant turn (with any tool_use blocks) to the conversation.
		const assistantTurnBlocks: ChatContentBlock[] = [...assistantBlocks];
		for (const call of pendingToolCalls) {
			assistantTurnBlocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
		}
		if (assistantTurnBlocks.length > 0) {
			messages.push({ role: 'assistant', content: assistantTurnBlocks });
		}

		if (stopReason === 'end_turn' || pendingToolCalls.length === 0) {
			yield { type: 'done', reason: 'completed' };
			return;
		}

		// Execute tool calls in order, append their results as a single user turn.
		const toolResults: ChatContentBlock[] = [];
		for (const call of pendingToolCalls) {
			if (args.signal.aborted) {
				yield { type: 'done', reason: 'cancelled' };
				return;
			}
			yield { type: 'tool_call', id: call.id, name: call.name, input: call.input };
			let resultText = '';
			let isError = false;
			try {
				const result = await vscode.lm.invokeTool(
					call.name,
					{ input: call.input as object, toolInvocationToken: undefined },
					new vscode.CancellationTokenSource().token,
				);
				resultText = result.content
					.filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
					.map(p => p.value)
					.join('\n');
				if (resultText.length === 0) {
					resultText = '(tool returned no text content)';
				}
			} catch (err) {
				resultText = err instanceof Error ? err.message : String(err);
				isError = true;
			}
			yield { type: 'tool_result', id: call.id, name: call.name, output: resultText, isError };
			toolResults.push({
				type: 'tool_result',
				toolUseId: call.id,
				output: resultText,
				isError,
			});
		}
		messages.push({ role: 'user', content: toolResults });

		// Loop - next iteration sends the tool results back to the model.
	}

	yield { type: 'done', reason: 'max_turns' };
}
