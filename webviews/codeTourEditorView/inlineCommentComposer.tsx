/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useState } from 'react';

interface InlineCommentComposerProps {
	targetLabel: string;
	submitLabel?: string;
	onSubmit: (body: string) => Promise<void>;
	onCancel: () => void;
}

export function InlineCommentComposer({ targetLabel, submitLabel, onSubmit, onCancel }: InlineCommentComposerProps) {
	const [body, setBody] = useState('');
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);

	const handleSubmit = useCallback(async () => {
		const trimmed = body.trim();
		if (!trimmed || submitting) {
			return;
		}
		setSubmitting(true);
		setError(undefined);
		try {
			await onSubmit(trimmed);
			setBody('');
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSubmitting(false);
		}
	}, [body, onSubmit, submitting]);

	return (
		<div className="vc-thread">
			<div className="vc-thread-header">
				<span className="vc-thread-target">{targetLabel}</span>
			</div>
			<div className="vc-reply">
				<textarea
					className="vc-reply-textarea"
					value={body}
					onChange={e => setBody(e.target.value)}
					placeholder="Leave a comment"
					rows={3}
					autoFocus
					disabled={submitting}
					onKeyDown={e => {
						if (e.key === 'Escape') {
							e.preventDefault();
							onCancel();
						}
					}}
				/>
				{error && <div className="vc-error">{error}</div>}
				<div className="vc-reply-actions">
					<button
						type="button"
						className="secondary"
						onClick={onCancel}
						disabled={submitting}
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={handleSubmit}
						disabled={submitting || body.trim().length === 0}
					>
						{submitting ? 'Submitting…' : submitLabel ?? 'Comment'}
					</button>
				</div>
			</div>
		</div>
	);
}
