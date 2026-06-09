/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Tooltip } from './tooltip';
import { ellipsisIcon } from '../components/icon';

export interface OverflowMenuItem {
	/** Stable key for React. */
	key: string;
	/** Action label, shown as the button's tooltip / accessible name. */
	label: string;
	/** Icon node. */
	icon: React.ReactNode;
	onSelect: () => void;
	disabled?: boolean;
}

/** Approximate width of one 24px icon button + the 4px row gap. */
const ITEM_WIDTH_PX = 28;
const POPOVER_PADDING_PX = 8;
const POPOVER_GAP_PX = 4;

/**
 * A compact "⋯" (more) button that opens a small horizontal row of icon
 * buttons. Used to keep crowded action rows (hunk / file gutters) tidy: the
 * always-on controls (expand, select) stay inline and the secondary actions
 * collapse in here.
 *
 * The popover is rendered through a portal to `document.body` with fixed
 * positioning, because the action rows live inside `overflow: auto` scroll
 * containers (the changes pane, the diff table) that would otherwise clip an
 * absolutely-positioned popover. Click-outside and Escape close it; scrolling
 * or resizing also closes it (a fixed-position popover would otherwise drift
 * away from its trigger).
 */
export function OverflowMenu({
	items,
	title = 'More actions',
}: {
	items: OverflowMenuItem[];
	title?: string;
}) {
	const [open, setOpen] = useState(false);
	const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
	const triggerRef = useRef<HTMLSpanElement>(null);
	const popoverRef = useRef<HTMLDivElement>(null);

	// Position the portaled popover just below the trigger, right-aligned to
	// the trigger's right edge, clamped to stay on-screen.
	useLayoutEffect(() => {
		if (!open || !triggerRef.current) {
			return;
		}
		const rect = triggerRef.current.getBoundingClientRect();
		const width = items.length * ITEM_WIDTH_PX + POPOVER_PADDING_PX;
		let left = rect.right - width;
		if (left < POPOVER_GAP_PX) {
			left = POPOVER_GAP_PX;
		}
		const maxLeft = window.innerWidth - width - POPOVER_GAP_PX;
		if (left > maxLeft) {
			left = Math.max(POPOVER_GAP_PX, maxLeft);
		}
		setPos({ top: rect.bottom + POPOVER_GAP_PX, left });
	}, [open, items.length]);

	useEffect(() => {
		if (!open) {
			return;
		}
		const handleMouseDown = (event: MouseEvent) => {
			const target = event.target as Node;
			if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) {
				return;
			}
			setOpen(false);
		};
		const handleKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				setOpen(false);
			}
		};
		const handleReposition = () => setOpen(false);
		document.addEventListener('mousedown', handleMouseDown);
		document.addEventListener('keydown', handleKey);
		// Capture-phase scroll so nested scroll containers also dismiss.
		window.addEventListener('scroll', handleReposition, true);
		window.addEventListener('resize', handleReposition);
		return () => {
			document.removeEventListener('mousedown', handleMouseDown);
			document.removeEventListener('keydown', handleKey);
			window.removeEventListener('scroll', handleReposition, true);
			window.removeEventListener('resize', handleReposition);
		};
	}, [open]);

	const select = useCallback((item: OverflowMenuItem) => {
		setOpen(false);
		item.onSelect();
	}, []);

	if (items.length === 0) {
		return null;
	}

	return (
		<span className="overflow-menu" onClick={e => e.stopPropagation()}>
			<Tooltip text={title}>
				<span
					ref={triggerRef}
					className="icon-button overflow-menu-trigger"
					role="button"
					tabIndex={0}
					aria-haspopup="menu"
					aria-expanded={open}
					onClick={e => { e.stopPropagation(); setOpen(v => !v); }}
					onKeyDown={e => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							setOpen(v => !v);
						}
					}}
				>
					{ellipsisIcon}
				</span>
			</Tooltip>
			{open && pos && createPortal(
				<div
					ref={popoverRef}
					className="overflow-menu-popover"
					role="menu"
					style={{ top: pos.top, left: pos.left }}
					onClick={e => e.stopPropagation()}
				>
					{items.map(item => (
						<Tooltip key={item.key} text={item.label}>
							<button
								type="button"
								role="menuitem"
								className="overflow-menu-item icon-button"
								aria-label={item.label}
								disabled={item.disabled}
								onClick={e => { e.stopPropagation(); select(item); }}
							>
								{item.icon}
							</button>
						</Tooltip>
					))}
				</div>,
				document.body,
			)}
		</span>
	);
}
