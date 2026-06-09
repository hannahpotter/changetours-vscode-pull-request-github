/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import Anthropic from '@anthropic-ai/sdk';
import { ChatContentBlock, ChatMessage, ChatStreamEvent, StreamChatArgs, TourAssistantProvider } from './provider';

/**
 * Direct Anthropic API provider. Used as a fallback when no `vscode.lm` chat
 * model is available, or when the user explicitly sets
 * `changeTour.assistant.provider: 'anthropic'`. API key is read from
 * `vscode.SecretStorage` and passed in from `resolveProvider`.
 *
 * Uses prompt caching on the system prompt + initial tool block (5-min TTL) so
 * multi-turn tool-use loops only pay full price for the first turn.
 */
export class AnthropicProvider implements TourAssistantProvider {
	readonly id = 'anthropic' as const;
	private readonly client: Anthropic;

	constructor(apiKey: string, private readonly modelName: string) {
		this.client = new Anthropic({ apiKey });
	}

	get label(): string {
		return `Anthropic ${this.modelName}`;
	}

	async *streamChat(args: StreamChatArgs): AsyncIterable<ChatStreamEvent> {
		const tools: Anthropic.Messages.Tool[] = args.tools.map((t, i) => ({
			name: t.name,
			description: t.description,
			input_schema: t.inputSchema as Anthropic.Messages.Tool.InputSchema,
			// Cache the tool definitions block (singular cache_control on the LAST tool
			// caches everything up to and including the tools block).
			...(i === args.tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
		}));

		const messages: Anthropic.Messages.MessageParam[] = args.messages.map(m => ({
			role: m.role,
			content: this.toAnthropicContent(m.content),
		}));

		const stream = this.client.messages.stream({
			model: args.model ?? this.modelName,
			max_tokens: args.maxTokens ?? 4096,
			system: [
				{
					type: 'text',
					text: args.system,
					cache_control: { type: 'ephemeral' as const },
				},
			],
			tools,
			messages,
		});

		// Wire the abort signal to abort the stream.
		const abortHandler = () => stream.controller.abort();
		args.signal.addEventListener('abort', abortHandler);

		// Track partial tool-use blocks as they stream so we can emit a single
		// `tool_use_end` event with the fully assembled input.
		const pendingTools = new Map<number, { id: string; name: string; jsonAccum: string }>();
		let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'cancelled' | 'error' = 'end_turn';
		let errorMessage: string | undefined;

		try {
			for await (const event of stream) {
				if (args.signal.aborted) {
					stopReason = 'cancelled';
					break;
				}
				switch (event.type) {
					case 'content_block_start':
						if (event.content_block.type === 'tool_use') {
							pendingTools.set(event.index, {
								id: event.content_block.id,
								name: event.content_block.name,
								jsonAccum: '',
							});
							yield {
								type: 'tool_use_start',
								id: event.content_block.id,
								name: event.content_block.name,
							};
						}
						break;
					case 'content_block_delta':
						if (event.delta.type === 'text_delta') {
							yield { type: 'text_delta', text: event.delta.text };
						} else if (event.delta.type === 'input_json_delta') {
							const pending = pendingTools.get(event.index);
							if (pending) {
								pending.jsonAccum += event.delta.partial_json;
								yield {
									type: 'tool_use_input_delta',
									id: pending.id,
									jsonDelta: event.delta.partial_json,
								};
							}
						}
						break;
					case 'content_block_stop': {
						const pending = pendingTools.get(event.index);
						if (pending) {
							let parsed: unknown = {};
							try {
								parsed = pending.jsonAccum.length > 0 ? JSON.parse(pending.jsonAccum) : {};
							} catch {
								// Malformed - pass the raw string so the orchestrator can surface the error.
								parsed = { _malformedJson: pending.jsonAccum };
							}
							yield { type: 'tool_use_end', id: pending.id, input: parsed };
							pendingTools.delete(event.index);
						}
						break;
					}
					case 'message_delta':
						if (event.delta.stop_reason === 'tool_use') {
							stopReason = 'tool_use';
						} else if (event.delta.stop_reason === 'max_tokens') {
							stopReason = 'max_tokens';
						} else if (event.delta.stop_reason === 'end_turn') {
							stopReason = 'end_turn';
						}
						break;
				}
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
		}

		yield { type: 'message_end', stopReason, error: errorMessage };
	}

	private toAnthropicContent(content: ChatMessage['content']): Anthropic.Messages.ContentBlockParam[] | string {
		if (typeof content === 'string') {
			return content;
		}
		return content.map((block: ChatContentBlock): Anthropic.Messages.ContentBlockParam => {
			switch (block.type) {
				case 'text':
					return { type: 'text', text: block.text };
				case 'tool_use':
					return { type: 'tool_use', id: block.id, name: block.name, input: (block.input ?? {}) as object };
				case 'tool_result':
					return {
						type: 'tool_result',
						tool_use_id: block.toolUseId,
						content: block.output,
						is_error: block.isError,
					};
			}
		});
	}
}
