/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Helpers for recognizing and presenting GitHub API rate-limit failures.
 *
 * Why this exists: the Change Tour code paths make several GitHub API calls
 * (resolve PR, list files, list review threads, fetch PR description for the
 * chat participant). When the user blows past their rate-limit budget those
 * calls throw, and the underlying Octokit error message ("Request failed with
 * status code 403") is not actionable - users can't tell rate-limit from
 * auth-revoked from network blip. Each caller wraps its failing call site,
 * calls `detectRateLimit`, and either swaps in a human-readable error message
 * (LM tools, comments) or routes a banner-trigger message to the webview
 * (editor backend).
 *
 * Detection rules (kept deliberately permissive - missing headers are OK):
 *   - Primary REST limit: `status === 403 && x-ratelimit-remaining === '0'`
 *   - Secondary / abuse limit: `(status === 403 || 429) && retry-after present`
 *   - GraphQL: Apollo wraps GitHub's body under `networkError.result.errors[]`
 *     or `graphQLErrors[]` with `type === 'RATE_LIMITED'`.
 *   - Anything else (401, plain 403 without remaining header, network errors):
 *     return `undefined` so the caller falls through to its existing path.
 */

export interface RateLimitInfo {
	/** When the limit resets. For secondary limits, this is `now + retry-after`. */
	resetAt: Date;
	/** Remaining requests at the moment the error fired (0 for primary; -1 if unknown). */
	remaining: number;
	/** Which GitHub bucket was exhausted. `'secondary'` covers abuse-detection / retry-after responses. */
	resource: 'core' | 'graphql' | 'search' | 'secondary';
	/** True for abuse/secondary rate limits (driven by `retry-after`), false for primary quota exhaustion. */
	isSecondary: boolean;
}

type HeadersLike = Record<string, string | string[] | undefined>;

function getHeader(headers: HeadersLike | undefined, name: string): string | undefined {
	if (!headers) {
		return undefined;
	}
	// Octokit gives lowercase header names already, but be defensive in case
	// some path passes through a different client (e.g. Apollo's fetch).
	const direct = headers[name];
	if (typeof direct === 'string') {
		return direct;
	}
	if (Array.isArray(direct) && direct.length > 0) {
		return direct[0];
	}
	const upperFirst = headers[name.replace(/(^|-)\w/g, c => c.toUpperCase())];
	if (typeof upperFirst === 'string') {
		return upperFirst;
	}
	return undefined;
}

function normalizeResource(raw: string | undefined): RateLimitInfo['resource'] {
	switch (raw) {
		case 'search': return 'search';
		case 'graphql': return 'graphql';
		case 'core':
		default: return 'core';
	}
}

/**
 * Try to recognize `e` as a GitHub rate-limit error. Returns `undefined` for
 * anything that isn't unambiguously a rate-limit case so the caller can fall
 * through to the existing error handling (auth dialog, generic toast, etc.).
 */
export function detectRateLimit(e: unknown): RateLimitInfo | undefined {
	if (!e || typeof e !== 'object') {
		return undefined;
	}
	const err = e as {
		status?: number;
		response?: { headers?: HeadersLike };
		// Apollo-style nested shapes:
		networkError?: { statusCode?: number; result?: { errors?: Array<{ type?: string; message?: string }> } };
		graphQLErrors?: Array<{ extensions?: { code?: string }; message?: string }>;
	};

	// REST path - Octokit attaches `status` and `response.headers`.
	const status = err.status;
	const headers = err.response?.headers;
	if (status === 403 || status === 429) {
		const retryAfter = getHeader(headers, 'retry-after');
		if (retryAfter !== undefined) {
			// Secondary / abuse rate limit. `retry-after` is seconds.
			const seconds = Number(retryAfter);
			if (Number.isFinite(seconds) && seconds >= 0) {
				return {
					resetAt: new Date(Date.now() + seconds * 1000),
					remaining: 0,
					resource: 'secondary',
					isSecondary: true,
				};
			}
		}
		const remainingStr = getHeader(headers, 'x-ratelimit-remaining');
		if (remainingStr === '0') {
			const resetStr = getHeader(headers, 'x-ratelimit-reset');
			const resetSeconds = resetStr !== undefined ? Number(resetStr) : NaN;
			const resetAt = Number.isFinite(resetSeconds)
				? new Date(resetSeconds * 1000)
				// No reset header: pick a conservative 60s in the future so the
				// banner still renders with something useful.
				: new Date(Date.now() + 60 * 1000);
			return {
				resetAt,
				remaining: 0,
				resource: normalizeResource(getHeader(headers, 'x-ratelimit-resource')),
				isSecondary: false,
			};
		}
		// 403 with a populated remaining header (or no rate-limit headers at
		// all) is probably auth/scope - leave it to the caller.
	}

	// GraphQL path - Apollo wraps the response either in `networkError.result`
	// (HTTP-level) or `graphQLErrors` (well-formed 200 with GraphQL errors).
	const apolloErrors = err.networkError?.result?.errors ?? [];
	for (const ge of apolloErrors) {
		if (ge?.type === 'RATE_LIMITED') {
			return {
				// GitHub's GraphQL RATE_LIMITED doesn't carry a reset timestamp
				// in the response body; default to ~60s out and let the user
				// retry. (The schema's `rateLimit.resetAt` is on a successful
				// query, not on the error envelope.)
				resetAt: new Date(Date.now() + 60 * 1000),
				remaining: 0,
				resource: 'graphql',
				isSecondary: false,
			};
		}
	}
	for (const ge of err.graphQLErrors ?? []) {
		if (ge?.extensions?.code === 'RATE_LIMITED') {
			return {
				resetAt: new Date(Date.now() + 60 * 1000),
				remaining: 0,
				resource: 'graphql',
				isSecondary: false,
			};
		}
	}

	return undefined;
}

/**
 * Render a human-readable, one-sentence summary for an error message or a
 * chat surface. Locale-aware time formatting; relative "in N min" hint so
 * the user has both the wall-clock value (for context-switching) and the
 * delta (for impatience).
 */
export function formatRateLimitMessage(info: RateLimitInfo): string {
	const resetMs = info.resetAt.getTime();
	const deltaMs = Math.max(0, resetMs - Date.now());
	const minutes = Math.round(deltaMs / 60000);
	const relative = deltaMs < 60000
		? 'in less than a minute'
		: minutes === 1
			? 'in 1 minute'
			: minutes < 60
				? `in ${minutes} minutes`
				: `in about ${Math.round(minutes / 60)} hour${minutes >= 90 ? 's' : ''}`;
	const wallClock = info.resetAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
	const lead = info.isSecondary
		? 'GitHub API secondary rate limit hit (too many requests in a short window).'
		: info.resource === 'graphql'
			? 'GitHub GraphQL API rate limit hit.'
			: info.resource === 'search'
				? 'GitHub search API rate limit hit.'
				: 'GitHub API rate limit hit.';
	return `${lead} Resets at ${wallClock} (${relative}).`;
}
