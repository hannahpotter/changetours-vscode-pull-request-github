/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as marked from 'marked';
import React, { useCallback, useMemo, useState } from 'react';
import type { IComment, IReviewThread } from '../../src/common/comment';
import { Tooltip } from '../common/tooltip';
import { chevronDownIcon } from '../components/icon';

interface InlineCommentThreadProps {
	thread: IReviewThread;
	onReply: (thread: IReviewThread, body: string) => Promise<void>;
	replyDisabled?: boolean;
	replyDisabledReason?: string;
}

function formatRelativeDate(iso: string | undefined): string {
	if (!iso) {
		return '';
	}
	const then = Date.parse(iso);
	if (isNaN(then)) {
		return iso;
	}
	const diffMs = Date.now() - then;
	const sec = Math.round(diffMs / 1000);
	if (sec < 60) {
		return 'just now';
	}
	const min = Math.round(sec / 60);
	if (min < 60) {
		return `${min}m ago`;
	}
	const hr = Math.round(min / 60);
	if (hr < 24) {
		return `${hr}h ago`;
	}
	const day = Math.round(hr / 24);
	if (day < 30) {
		return `${day}d ago`;
	}
	try {
		return new Date(then).toLocaleDateString();
	} catch {
		return iso;
	}
}

export function InlineCommentThread({ thread, onReply, replyDisabled, replyDisabledReason }: InlineCommentThreadProps) {
	const [expanded, setExpanded] = useState(!thread.isResolved);
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

	const commentCount = thread.comments.length;
	const summary = commentCount === 1 ? '1 comment' : `${commentCount} comments`;

	return (
		<div className={`vc-thread${thread.isResolved ? ' vc-thread-resolved' : ''}${thread.isOutdated ? ' vc-thread-outdated' : ''}`}>
			<div className="vc-thread-header">
				<Tooltip text={expanded ? 'Collapse thread' : 'Expand thread'}>
					<span
						role="button"
						tabIndex={0}
						className={`expand-icon icon-button vc-thread-toggle${expanded ? '' : ' closed'}`}
						onClick={e => { e.stopPropagation(); setExpanded(v => !v); }}
						onKeyDown={e => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								e.stopPropagation();
								setExpanded(v => !v);
							}
						}}
					>
						{chevronDownIcon}
					</span>
				</Tooltip>
				<span className="vc-thread-target">
					{thread.path}:{thread.startLine === thread.endLine ? thread.endLine : `${thread.startLine}-${thread.endLine}`}
				</span>
				{!expanded && <span className="vc-thread-summary">{summary}</span>}
				{thread.isResolved && <span className="vc-thread-badge">Resolved</span>}
				{thread.isOutdated && <span className="vc-thread-badge">Outdated</span>}
			</div>
			{expanded && (
				<>
					<div className="vc-comments">
						{thread.comments.map(c => (
							<CommentRow key={c.id} comment={c} />
						))}
					</div>
					{!replyOpen ? (
						<div className="vc-reply">
							<Tooltip text={replyDisabled ? replyDisabledReason ?? 'Reply unavailable' : 'Reply to this thread'}>
								<div
									role="button"
									tabIndex={replyDisabled ? -1 : 0}
									className={`vc-reply-trigger${replyDisabled ? ' is-disabled' : ''}`}
									onClick={() => { if (!replyDisabled) setReplyOpen(true); }}
									onKeyDown={e => {
										if (replyDisabled) return;
										if (e.key === 'Enter' || e.key === ' ') {
											e.preventDefault();
											setReplyOpen(true);
										}
									}}
								>
									Reply…
								</div>
							</Tooltip>
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
				</>
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
				<span className="vc-comment-date" title={comment.createdAt}>{formatRelativeDate(comment.createdAt)}</span>
				{comment.isDraft && <span className="vc-thread-badge">Pending</span>}
			</div>
			<div className="vc-comment-body" dangerouslySetInnerHTML={{ __html: rendered }} />
		</div>
	);
}
