/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';
import { ChatContentBlock, ChatMessage, ChatStreamEvent, StreamChatArgs, TourAssistantProvider } from './provider';

/**
 * Provider implementation backed by `vscode.lm` - works with whatever chat
 * model the user has registered (Copilot's GPT, Copilot's Claude, Cody,
 * Continue, etc.). Translates our internal `ChatMessage` + `ToolSpec` shape
 * into `LanguageModelChatMessage[]` + `LanguageModelChatTool[]`.
 */
export class VSCodeLMProvider implements TourAssistantProvider {
	readonly id = 'vscode-lm' as const;

	constructor(private readonly model: vscode.LanguageModelChat) { }

	get label(): string {
		return `${this.model.vendor} ${this.model.name}`;
	}

	async *streamChat(args: StreamChatArgs): AsyncIterable<ChatStreamEvent> {
		const messages = this.translateMessages(args.system, args.messages);
		const tools = args.tools.map<vscode.LanguageModelChatTool>(t => ({
			name: t.name,
			description: t.description,
			inputSchema: t.inputSchema,
		}));

		const cancellation = new vscode.CancellationTokenSource();
		// Bridge the abort signal to the cancellation token.
		const abortHandler = () => cancellation.cancel();
		args.signal.addEventListener('abort', abortHandler);

		let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'cancelled' | 'error' = 'end_turn';
		let sawToolCall = false;
		let errorMessage: string | undefined;

		try {
			const response = await this.model.sendRequest(
				messages,
				{ tools, toolMode: vscode.LanguageModelChatToolMode.Auto },
				cancellation.token,
			);

			for await (const part of response.stream) {
				if (args.signal.aborted) {
					stopReason = 'cancelled';
					break;
				}
				if (part instanceof vscode.LanguageModelTextPart) {
					yield { type: 'text_delta', text: part.value };
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					sawToolCall = true;
					// VS Code returns the tool call fully assembled (not streamed),
					// so we emit start + end together with the resolved input.
					yield { type: 'tool_use_start', id: part.callId, name: part.name };
					yield { type: 'tool_use_end', id: part.callId, input: part.input };
				}
				// Other part types (e.g. data parts) are ignored - orchestrator only
				// cares about text and tool calls.
			}

			if (stopReason !== 'cancelled') {
				stopReason = sawToolCall ? 'tool_use' : 'end_turn';
			}
		} catch (err) {
			if (args.signal.aborted) {
				stopReason = 'cancelled';
			} else {
				stopReason = 'error';
				errorMessage = err instanceof Error ? err.message : String(err);
			}
		} finally {
			args.signal.removeEventListener('abort', abortHandler);
			cancellation.dispose();
		}

		yield { type: 'message_end', stopReason, error: errorMessage };
	}

	private translateMessages(system: string, messages: ChatMessage[]): vscode.LanguageModelChatMessage[] {
		// VS Code's LM API doesn't have a dedicated "system" slot - convention is
		// to prepend a User message containing the system instructions, which the
		// participating models (Copilot's especially) understand as system prompt.
		const result: vscode.LanguageModelChatMessage[] = [
			vscode.LanguageModelChatMessage.User(system),
		];

		for (const message of messages) {
			const blocks = toBlockArray(message.content);

			if (message.role === 'assistant') {
				// Assistant turn: text + tool_use blocks (tool_result is invalid for assistant).
				const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
				for (const block of blocks) {
					if (block.type === 'text' && block.text.length > 0) {
						parts.push(new vscode.LanguageModelTextPart(block.text));
					} else if (block.type === 'tool_use') {
						parts.push(new vscode.LanguageModelToolCallPart(block.id, block.name, (block.input ?? {}) as object));
					}
					// tool_result blocks intentionally dropped for assistant turns.
				}
				if (parts.length > 0) {
					result.push(vscode.LanguageModelChatMessage.Assistant(parts));
				}
			} else {
				// User turn: text + tool_result blocks (tool_use is invalid for user).
				const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart)[] = [];
				for (const block of blocks) {
					if (block.type === 'text' && block.text.length > 0) {
						parts.push(new vscode.LanguageModelTextPart(block.text));
					} else if (block.type === 'tool_result') {
						parts.push(new vscode.LanguageModelToolResultPart(block.toolUseId, [
							new vscode.LanguageModelTextPart(block.output),
						]));
					}
					// tool_use blocks intentionally dropped for user turns.
				}
				if (parts.length > 0) {
					result.push(vscode.LanguageModelChatMessage.User(parts));
				}
			}
		}

		return result;
	}
}

function toBlockArray(content: ChatMessage['content']): ChatContentBlock[] {
	if (typeof content === 'string') {
		return [{ type: 'text', text: content }];
	}
	return content;
}
