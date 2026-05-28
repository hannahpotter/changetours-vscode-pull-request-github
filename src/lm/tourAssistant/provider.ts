/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as vscode from 'vscode';

/**
 * Internal, provider-agnostic representation of a chat message. Both the
 * VSCodeLMProvider and AnthropicProvider translate this shape into their
 * respective wire formats. This isolates the orchestrator from any one SDK.
 */
export interface ChatMessage {
	role: 'user' | 'assistant';
	/**
	 * Content blocks. The orchestrator may emit:
	 * - `text` blocks (plain prose to/from the model)
	 * - `tool_use` blocks (assistant requesting a tool call) - only valid for `role: 'assistant'`
	 * - `tool_result` blocks (the result of a previous tool call) - only valid for `role: 'user'`
	 *
	 * Plain text-only turns can use the convenience `text` field instead of an array.
	 */
	content: string | ChatContentBlock[];
}

export type ChatContentBlock =
	| { type: 'text'; text: string }
	| { type: 'tool_use'; id: string; name: string; input: unknown }
	| { type: 'tool_result'; toolUseId: string; output: string; isError?: boolean };

/**
 * Provider-agnostic tool specification handed to `streamChat`. Mirrors the
 * intersection of `vscode.LanguageModelChatTool` and Anthropic's tool format.
 */
export interface ToolSpec {
	name: string;
	description: string;
	inputSchema: object;
}

/**
 * Streaming events emitted as the provider's response arrives. Consumers
 * (orchestrator) typically buffer `tool_use_*` events until `tool_use_end` to
 * reconstruct a complete tool call, and forward `text_delta` events to the UI
 * as they arrive.
 */
export type ChatStreamEvent =
	| { type: 'text_delta'; text: string }
	| { type: 'tool_use_start'; id: string; name: string }
	| { type: 'tool_use_input_delta'; id: string; jsonDelta: string }
	| { type: 'tool_use_end'; id: string; input: unknown }
	| { type: 'message_end'; stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'cancelled' | 'error'; error?: string };

export interface StreamChatArgs {
	system: string;
	messages: ChatMessage[];
	tools: ToolSpec[];
	signal: AbortSignal;
	/** Optional model override; provider may ignore or substitute. */
	model?: string;
	/** Soft cap on response tokens. */
	maxTokens?: number;
}

export interface TourAssistantProvider {
	readonly id: 'vscode-lm' | 'anthropic';
	/** Human-readable label for diagnostics ("Copilot GPT-4o", "Claude 3.5 Sonnet"). */
	readonly label: string;
	streamChat(args: StreamChatArgs): AsyncIterable<ChatStreamEvent>;
}

export interface ProviderResolutionContext {
	context: vscode.ExtensionContext;
	/** If provided, the participant's chat request model will be used by the vscode-lm provider. */
	requestedModel?: vscode.LanguageModelChat;
}

const SETTINGS_NAMESPACE = 'changeTour.assistant';
const ANTHROPIC_KEY_SECRET = 'changeTour.assistant.anthropicApiKey';

/**
 * Resolve a provider at runtime based on user settings + available models.
 *
 * 1. If `provider === 'anthropic'` and a key is stored → AnthropicProvider.
 * 2. Else if any `vscode.lm` chat model is available → VSCodeLMProvider.
 *    (When `provider === 'vscode-lm'` we use this branch regardless of stored keys.)
 * 3. Else if an Anthropic key is stored → AnthropicProvider.
 * 4. Else throw a user-friendly error pointing to the "Set Anthropic API key" command.
 */
export async function resolveProvider(ctx: ProviderResolutionContext): Promise<TourAssistantProvider> {
	const cfg = vscode.workspace.getConfiguration(SETTINGS_NAMESPACE);
	const choice = cfg.get<'auto' | 'vscode-lm' | 'anthropic'>('provider', 'auto');

	const tryAnthropic = async (): Promise<TourAssistantProvider | undefined> => {
		const key = await ctx.context.secrets.get(ANTHROPIC_KEY_SECRET);
		if (!key) {
			return undefined;
		}
		// Dynamic import keeps the SDK out of the load path for vscode-lm-only users.
		const { AnthropicProvider } = await import('./anthropicProvider');
		const model = cfg.get<string>('anthropicModel', 'claude-3-5-sonnet-latest');
		return new AnthropicProvider(key, model);
	};

	const tryVSCodeLM = async (): Promise<TourAssistantProvider | undefined> => {
		const { VSCodeLMProvider } = await import('./vscodeLMProvider');
		if (ctx.requestedModel) {
			return new VSCodeLMProvider(ctx.requestedModel);
		}
		const models = await vscode.lm.selectChatModels();
		if (models.length === 0) {
			return undefined;
		}
		// Prefer a Copilot model when present; otherwise just the first available.
		const preferred = models.find(m => m.vendor === 'copilot') ?? models[0];
		return new VSCodeLMProvider(preferred);
	};

	if (choice === 'anthropic') {
		const provider = await tryAnthropic();
		if (provider) {
			return provider;
		}
		throw makeNoKeyError();
	}

	if (choice === 'vscode-lm') {
		const provider = await tryVSCodeLM();
		if (provider) {
			return provider;
		}
		throw new Error(vscode.l10n.t('No language model is available. Install GitHub Copilot or another chat provider, or switch the Change Tour assistant to "anthropic".'));
	}

	// 'auto' - prefer vscode.lm, fall back to Anthropic.
	const lmProvider = await tryVSCodeLM();
	if (lmProvider) {
		return lmProvider;
	}
	const anthropicProvider = await tryAnthropic();
	if (anthropicProvider) {
		return anthropicProvider;
	}
	throw makeNoKeyError();
}

function makeNoKeyError(): Error {
	const message = vscode.l10n.t('No language model is available. Set an Anthropic API key via the "Change Tour: Set Anthropic API Key" command, or install GitHub Copilot.');
	return new Error(message);
}

/** Stable secret key for the Anthropic API key, exported for reuse by commands. */
export const ANTHROPIC_API_KEY_SECRET = ANTHROPIC_KEY_SECRET;
