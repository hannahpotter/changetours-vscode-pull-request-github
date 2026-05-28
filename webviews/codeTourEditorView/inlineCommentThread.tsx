/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as marked from 'marked';
import React, { useCallback, useMemo, useState } from 'react';
import type { IComment, IReviewThread } from '../../src/common/comment';

interface InlineCommentThreadProps {
	thread: IReviewThread;
	onReply: (thread: IReviewThread, body: string) => Promise<void>;
	replyDisabled?: boolean;
	replyDisabledReason?: string;
}

function formatDate(iso: string | undefined): string {
	if (!iso) {
		return '';
	}
	try {
		return new Date(iso).toLocaleString();
	} catch {
		return iso;
	}
}

export function InlineCommentThread({ thread, onReply, replyDisabled, replyDisabledReason }: InlineCommentThreadProps) {
	const [replyOpen, setReplyOpen] = useState(false);
	const [replyBody, setReplyBody] = useState('');
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);

	const handleReplySubmit = useCallback(async () => {
		const trimmed = replyBody.trim();
		if (!trimmed || submitting) {
			return;
		}
		setSubmitting(true);
		setError(undefined);
		try {
			await onReply(thread, trimmed);
			setReplyBody('');
			setReplyOpen(false);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSubmitting(false);
		}
	}, [replyBody, submitting, onReply, thread]);

	return (
		<div className={`vc-thread${thread.isResolved ? ' vc-thread-resolved' : ''}${thread.isOutdated ? ' vc-thread-outdated' : ''}`}>
			<div className="vc-thread-header">
				<span className="vc-thread-target">
					{thread.path}:{thread.startLine === thread.endLine ? thread.endLine : `${thread.startLine}-${thread.endLine}`}
				</span>
				{thread.isResolved && <span className="vc-thread-badge">Resolved</span>}
				{thread.isOutdated && <span className="vc-thread-badge">Outdated</span>}
			</div>
			<div className="vc-comments">
				{thread.comments.map(c => (
					<CommentRow key={c.id} comment={c} />
				))}
			</div>
			{!replyOpen ? (
				<div className="vc-reply">
					<button
						type="button"
						className="vc-reply-trigger"
						onClick={() => setReplyOpen(true)}
						disabled={replyDisabled}
						title={replyDisabled ? replyDisabledReason ?? 'Reply unavailable' : 'Reply to this thread'}
					>
						Reply…
					</button>
				</div>
			) : (
				<div className="vc-reply">
					<textarea
						className="vc-reply-textarea"
						value={replyBody}
						onChange={e => setReplyBody(e.target.value)}
						placeholder="Write a reply"
						rows={3}
						autoFocus
						disabled={submitting}
						onKeyDown={e => {
							if (e.key === 'Escape') {
								e.preventDefault();
								setReplyOpen(false);
								setReplyBody('');
								setError(undefined);
							}
						}}
					/>
					{error && <div className="vc-error">{error}</div>}
					<div className="vc-reply-actions">
						<button
							type="button"
							className="secondary"
							onClick={() => { setReplyOpen(false); setReplyBody(''); setError(undefined); }}
							disabled={submitting}
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={handleReplySubmit}
							disabled={submitting || replyBody.trim().length === 0}
						>
							{submitting ? 'Submitting…' : 'Reply'}
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

function CommentRow({ comment }: { comment: IComment }) {
	const rendered = useMemo(() => {
		if (comment.bodyHTML) {
			return comment.bodyHTML;
		}
		return marked.parse(comment.body) as string;
	}, [comment.bodyHTML, comment.body]);
	const author = comment.user?.login ?? 'unknown';
	const avatarUrl = comment.user?.avatarUrl;
	return (
		<div className="vc-comment">
			<div className="vc-comment-header">
				{avatarUrl && <img className="vc-comment-avatar" src={avatarUrl} alt="" />}
				<span className="vc-comment-author">{author}</span>
				<span className="vc-comment-date">{formatDate(comment.createdAt)}</span>
				{comment.isDraft && <span className="vc-thread-badge">Pending</span>}
			</div>
			<div className="vc-comment-body" dangerouslySetInnerHTML={{ __html: rendered }} />
		</div>
	);
}
