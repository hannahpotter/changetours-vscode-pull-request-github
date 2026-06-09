/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

/**
 * Webworker stub for AnthropicProvider.
 *
 * The real `anthropicProvider.ts` depends on `@anthropic-ai/sdk`, which pulls
 * in `node:child_process` and other Node-only builtins. Those don't exist in
 * VS Code Web (the webworker target). webpack.config.js swaps this stub in
 * via NormalModuleReplacementPlugin when bundling for `webworker`, so the
 * VS Code Web build doesn't try to bundle the SDK.
 *
 * If a user somehow ends up here at runtime, the provider yields a clean
 * `error` stop reason instead of crashing - they'll see a helpful message
 * telling them to switch to the vscode-lm provider.
 */

import { ChatStreamEvent, StreamChatArgs, TourAssistantProvider } from './provider';

export class AnthropicProvider implements TourAssistantProvider {
	readonly id = 'anthropic' as const;

	// The real constructor takes (apiKey, modelName); we keep the same signature
	// so call sites don't need to know they got the stub.
	constructor(_apiKey: string, private readonly modelName: string) { }

	get label(): string {
		return `Anthropic ${this.modelName} (unavailable in VS Code Web)`;
	}

	async *streamChat(_args: StreamChatArgs): AsyncIterable<ChatStreamEvent> {
		yield {
			type: 'message_end',
			stopReason: 'error',
			error: 'The direct Anthropic API provider is not available in VS Code Web. Use a VS Code language model (e.g. GitHub Copilot) instead, or open this workspace in desktop VS Code.',
		};
	}
}
