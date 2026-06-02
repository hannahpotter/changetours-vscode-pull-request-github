/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Lightweight custom tooltip used in place of the browser's native `title=`
 * attribute on action buttons.
 *
 * Why custom: the OS-level tooltip the browser draws for `title=` caches its
 * "I just showed this" state per element. In a webview with React re-renders
 * and toggleable buttons (whose `title` flips with state) the cache makes the
 * tooltip feel unreliable - it shows on first hover, then refuses to come back
 * until the cursor leaves and re-enters with a long enough gap. This component
 * sidesteps the cache by drawing its own tooltip via a portal.
 *
 * Usage:
 *     <Tooltip text="Highlight lines">
 *       <button onClick={...}>{editIcon}</button>
 *     </Tooltip>
 *
 * Behavior:
 *   - Shows after a short hover delay; hides instantly on mouse leave, blur,
 *     or click. (Click-to-hide so the tooltip doesn't linger after the user
 *     triggers the action.)
 *   - Strips the wrapped element's `title` attribute so the OS tooltip can't
 *     double-fire. Sets `aria-label` to `text` if the child doesn't already
 *     have one, so screen readers still get the label.
 *   - Disabled buttons fall back to the native `title` attribute, because
 *     Chromium suppresses mouseenter/leave on disabled <button> elements
 *     entirely - our handlers would never fire. The native tooltip works fine
 *     in this case (the user only complained about the enabled-button case).
 *   - Positions above the trigger by default, flips below when there's not
 *     enough room above. Clamps horizontally to keep the bubble on-screen.
 */
export interface TooltipProps {
	text: string;
	delay?: number;
	children: React.ReactElement;
}

interface TooltipPosition {
	left: number;
	top: number;
	placement: 'above' | 'below';
}

const DEFAULT_DELAY_MS = 400;
const TOOLTIP_OFFSET_PX = 6;
const VIEWPORT_PADDING_PX = 4;

export function Tooltip({ text, delay = DEFAULT_DELAY_MS, children }: TooltipProps): React.ReactElement {
	const [visible, setVisible] = useState(false);
	const [position, setPosition] = useState<TooltipPosition | null>(null);
	const triggerRef = useRef<HTMLElement | null>(null);
	const tooltipRef = useRef<HTMLDivElement | null>(null);
	const showTimerRef = useRef<number | null>(null);

	const clearShowTimer = useCallback(() => {
		if (showTimerRef.current !== null) {
			window.clearTimeout(showTimerRef.current);
			showTimerRef.current = null;
		}
	}, []);

	// Position is computed lazily after the bubble paints, so the bubble's
	// measured height can be used to flip above/below when space is tight.
	const computePosition = useCallback(() => {
		const trigger = triggerRef.current;
		const bubble = tooltipRef.current;
		if (!trigger || !bubble) {
			return;
		}
		const rect = trigger.getBoundingClientRect();
		const bubbleRect = bubble.getBoundingClientRect();
		const spaceAbove = rect.top;
		const placement: 'above' | 'below' =
			spaceAbove >= bubbleRect.height + TOOLTIP_OFFSET_PX + VIEWPORT_PADDING_PX
				? 'above'
				: 'below';
		const centerX = rect.left + rect.width / 2;
		const halfBubble = bubbleRect.width / 2;
		const minLeft = halfBubble + VIEWPORT_PADDING_PX;
		const maxLeft = window.innerWidth - halfBubble - VIEWPORT_PADDING_PX;
		const left = Math.max(minLeft, Math.min(maxLeft, centerX));
		const top = placement === 'above'
			? rect.top - TOOLTIP_OFFSET_PX
			: rect.bottom + TOOLTIP_OFFSET_PX;
		setPosition({ left, top, placement });
	}, []);

	const show = useCallback(() => {
		clearShowTimer();
		showTimerRef.current = window.setTimeout(() => {
			showTimerRef.current = null;
			setVisible(true);
		}, delay);
	}, [clearShowTimer, delay]);

	const hide = useCallback(() => {
		clearShowTimer();
		setVisible(false);
		setPosition(null);
	}, [clearShowTimer]);

	// Recompute placement after the bubble first paints (and on viewport
	// changes while shown). Using requestAnimationFrame avoids a layout
	// thrash from setting position state mid-render.
	useEffect(() => {
		if (!visible) {
			return;
		}
		const raf = window.requestAnimationFrame(() => computePosition());
		const onWindowChange = () => computePosition();
		window.addEventListener('scroll', onWindowChange, true);
		window.addEventListener('resize', onWindowChange);
		return () => {
			window.cancelAnimationFrame(raf);
			window.removeEventListener('scroll', onWindowChange, true);
			window.removeEventListener('resize', onWindowChange);
		};
	}, [visible, computePosition, text]);

	// Belt-and-suspenders cleanup so a pending timer can't fire after unmount.
	useEffect(() => () => clearShowTimer(), [clearShowTimer]);

	const child = React.Children.only(children);
	const childProps = child.props as Record<string, unknown> & {
		disabled?: boolean;
		title?: string;
		'aria-label'?: string;
		onMouseEnter?: (e: React.MouseEvent) => void;
		onMouseLeave?: (e: React.MouseEvent) => void;
		onFocus?: (e: React.FocusEvent) => void;
		onBlur?: (e: React.FocusEvent) => void;
		onClick?: (e: React.MouseEvent) => void;
		ref?: React.Ref<HTMLElement>;
	};

	// Disabled buttons don't emit mouse events in Chromium, so our handlers
	// would never fire. Keep the native title in that case - the OS tooltip
	// works fine for disabled controls (no toggle => no cache surprises).
	if (childProps.disabled) {
		return React.cloneElement(child, {
			title: text,
			'aria-label': childProps['aria-label'] ?? text,
		});
	}

	// Merge our ref with whatever ref the consumer already set on the child.
	const consumerRef = (child as unknown as { ref?: React.Ref<HTMLElement> }).ref;
	const setTriggerRef = (node: HTMLElement | null) => {
		triggerRef.current = node;
		if (typeof consumerRef === 'function') {
			consumerRef(node);
		} else if (consumerRef && typeof consumerRef === 'object') {
			(consumerRef as React.MutableRefObject<HTMLElement | null>).current = node;
		}
	};

	const enriched = React.cloneElement(child, {
		ref: setTriggerRef,
		// Strip the native title so we don't double-tooltip after the OS delay.
		title: undefined,
		'aria-label': childProps['aria-label'] ?? text,
		onMouseEnter: (e: React.MouseEvent) => {
			childProps.onMouseEnter?.(e);
			show();
		},
		onMouseLeave: (e: React.MouseEvent) => {
			childProps.onMouseLeave?.(e);
			hide();
		},
		onFocus: (e: React.FocusEvent) => {
			childProps.onFocus?.(e);
			show();
		},
		onBlur: (e: React.FocusEvent) => {
			childProps.onBlur?.(e);
			hide();
		},
		onClick: (e: React.MouseEvent) => {
			// Hide on click so the tooltip doesn't linger over the action.
			hide();
			childProps.onClick?.(e);
		},
	});

	return (
		<>
			{enriched}
			{visible && createPortal(
				<div
					ref={tooltipRef}
					className={`vsc-tooltip vsc-tooltip-${position?.placement ?? 'above'}`}
					role="tooltip"
					style={position
						? {
							left: position.left,
							top: position.top,
							transform: position.placement === 'above'
								? 'translate(-50%, -100%)'
								: 'translate(-50%, 0)',
						}
						// Render off-screen for the first paint so we can measure
						// the bubble before placing it. Avoids a visible flicker.
						: { left: -9999, top: -9999, visibility: 'hidden' }}
				>
					{text}
				</div>,
				document.body,
			)}
		</>
	);
}
