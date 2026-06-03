/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useEffect, useState } from 'react';
import { Tooltip } from './tooltip';

/**
 * Top-of-webview banner that surfaces GitHub API rate-limit failures the
 * extension hit while loading data for this Change Tour. Visually mirrors
 * the existing `tour-pr-warning` family (the outdated-tour banner and the
 * AI-review banner) but uses warning-yellow accents instead of error red,
 * since the situation is recoverable (wait + retry).
 *
 * Owning state lives in `app.tsx` so a single banner instance covers both
 * the edit and view layouts, and so the clear-on-success logic can hook
 * the same `changesData` / `threadsLoaded` messages the rest of the app
 * already routes.
 */

export interface RateLimitNotice {
	/** `Date.getTime()` value for when the limit resets. */
	resetAt: number;
	/** Which fetch hit the limit, so Retry knows what to re-trigger. */
	retryKind: 'changes' | 'threads';
	/** The human-readable sentence the extension computed (`formatRateLimitMessage`). */
	message: string;
	/** True for abuse / `retry-after` limits, false for primary quota exhaustion. */
	isSecondary: boolean;
	/** Which API bucket was exhausted. */
	resource: 'core' | 'graphql' | 'search' | 'secondary';
}

interface RateLimitBannerProps {
	notice: RateLimitNotice;
	onRetry: () => void;
	onViewLog: () => void;
	onDismiss: () => void;
}

function formatRelative(ms: number): string {
	if (ms <= 0) {
		return 'now';
	}
	if (ms < 60 * 1000) {
		const seconds = Math.max(1, Math.round(ms / 1000));
		return `in ${seconds}s`;
	}
	const minutes = Math.round(ms / 60000);
	if (minutes === 1) {
		return 'in 1 min';
	}
	if (minutes < 60) {
		return `in ${minutes} min`;
	}
	const hours = Math.round(minutes / 60);
	return `in ${hours}h`;
}

export function RateLimitBanner({ notice, onRetry, onViewLog, onDismiss }: RateLimitBannerProps): React.ReactElement {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		// Tick the relative time once a second so "in 12 min" counts down
		// while the banner is up. Cheap: one banner on screen at a time.
		const id = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(id);
	}, []);

	const remainingMs = notice.resetAt - now;
	const expired = remainingMs <= 0;
	const relative = formatRelative(remainingMs);

	return (
		<div className="tour-pr-warning tour-rate-limit-warning" role="status" aria-live="polite">
			<span>
				{notice.message}
				{!expired && (
					<>
						{' '}
						<span className="tour-rate-limit-countdown">({relative})</span>
					</>
				)}
				{expired && (
					<>
						{' '}
						<span className="tour-rate-limit-countdown">Try again now.</span>
					</>
				)}
			</span>
			<div className="tour-pr-warning-actions">
				<Tooltip text={notice.retryKind === 'changes'
					? 'Re-fetch the PR diff that just failed.'
					: 'Re-load the review-thread comments that just failed.'}>
					<button className="tour-action-btn" onClick={onRetry}>
						Retry
					</button>
				</Tooltip>
				<Tooltip text="Open the GitHub Pull Request output channel for the underlying log lines.">
					<button className="tour-action-btn" onClick={onViewLog}>
						View log
					</button>
				</Tooltip>
				<Tooltip text="Dismiss this banner. The underlying data won't load until you click Retry or the reset time passes.">
					<button className="tour-action-btn" onClick={onDismiss} aria-label="Dismiss">
						×
					</button>
				</Tooltip>
			</div>
		</div>
	);
}
