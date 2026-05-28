/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useState } from 'react';
import { ParsedDiffLine } from './diffUtils';
import { addIcon, chevronDownIcon, listTree } from '../components/icon';

interface DiffTableProps {
	lines: ParsedDiffLine[];
	onHunkHeaderDragStart?: (e: React.DragEvent, headerIdx: number) => void;
	onHunkAddActive?: (headerIdx: number) => void;
	onHunkAddQuickPick?: (headerIdx: number) => void;
	activeNodeContext?: string;
	coveredHeaderIndices?: Set<number>;
	hideCovered?: boolean;
	selectedHeaderIndices?: Set<number>;
	searchActive?: boolean;
	searchMatchedHeaderIndices?: Set<number>;
	searchMatchedLineIndices?: Set<number>;
	onHunkSelectToggle?: (headerIdx: number, selected: boolean) => void;
	selectedHunksCount?: number;
	highlightedLineIndices?: Set<number>;
	highlightMode?: boolean;
	onHighlightDragStart?: (lineIdx: number) => void;
	onHighlightDragEnter?: (lineIdx: number) => void;
	onHighlightDragEnd?: () => void;
	onRemoveHighlightForRow?: (lineIdx: number) => void;
	onAddCommentForLine?: (lineIdx: number) => void;
	composerLineIdx?: number | null;
	composerNode?: React.ReactNode;
	threadWidgetsByLineIdx?: Map<number, React.ReactNode>;
}

export function DiffTable({ lines, onHunkHeaderDragStart, onHunkAddActive, onHunkAddQuickPick, activeNodeContext, coveredHeaderIndices, hideCovered, selectedHeaderIndices, searchActive, searchMatchedHeaderIndices, searchMatchedLineIndices, onHunkSelectToggle, selectedHunksCount, highlightedLineIndices, highlightMode, onHighlightDragStart, onHighlightDragEnter, onHighlightDragEnd, onRemoveHighlightForRow, onAddCommentForLine, composerLineIdx, composerNode, threadWidgetsByLineIdx }: DiffTableProps) {
	let currentHeaderIdx = -1;
	const [collapsedState, setCollapsedState] = useState<{ [key: number]: boolean }>({});

	const toggleCollapse = (idx: number, isCurrentlyCovered: boolean) => {
		setCollapsedState(prev => ({
			...prev,
			[idx]: prev[idx] !== undefined ? !prev[idx] : !isCurrentlyCovered
		}));
	};

	return (
		<table className="diff-table">
			<tbody>
				{lines.map((line, i) => {
					if (line.type === 'hunk-header') {
						currentHeaderIdx = i;
						const draggable = !!onHunkHeaderDragStart;
						const isCovered = !!coveredHeaderIndices?.has(currentHeaderIdx);
						if (hideCovered && isCovered) {
							return null;
						}
						const isSearchMatch = !!searchActive && !!searchMatchedHeaderIndices?.has(currentHeaderIdx);
						const isCollapsed = isSearchMatch ? false : (collapsedState[currentHeaderIdx] !== undefined ? collapsedState[currentHeaderIdx] : isCovered);

						return (
							<tr
								key={i}
								className={`diff-line diff-hunk-header${draggable ? ' draggable-hunk' : ''}${isCovered ? ' diff-hunk-covered' : ''}${isSearchMatch ? ' diff-search-match' : ''}`}
								draggable={draggable || undefined}
								onDragStart={draggable ? e => onHunkHeaderDragStart!(e, i) : undefined}
								title={draggable ? 'Drag this hunk into a Change Tour editor' : undefined}
							>
								<td className="diff-line-num" colSpan={2}>
									<span className="diff-hunk-actions">
									<span className={`expand-icon icon-button ${isCollapsed ? 'closed' : ''}`} title={isCollapsed ? 'Expand hunk' : 'Collapse hunk'} onClick={(e) => { e.stopPropagation(); toggleCollapse(i, isCovered); }}>
										{chevronDownIcon}
									</span>
									{onHunkSelectToggle && (<div className="checkbox-wrapper">
										<input
											type="checkbox"
											title="Select hunk"
												checked={!!selectedHeaderIndices?.has(i)}
												onChange={(e) => onHunkSelectToggle?.(i, e.target.checked)}
												onClick={(e) => e.stopPropagation()}
											/>
										</div>)}
										{onHunkAddActive && (
											<span
												className="icon-button"
												title={selectedHunksCount && selectedHunksCount > 1 ? `Insert ${selectedHunksCount} selected hunks${activeNodeContext ? ` after: ${activeNodeContext}` : ''}` : (activeNodeContext ? `Insert after: ${activeNodeContext}` : 'Append to end of tour')}
												onClick={(e) => { e.stopPropagation(); onHunkAddActive(i); }}
											>
												{addIcon}
											</span>
										)}
										{onHunkAddQuickPick && (
											<span
												className="icon-button"
												title={selectedHunksCount && selectedHunksCount > 1 ? `Add ${selectedHunksCount} selected hunks to Section...` : 'Add Hunk to Section...'}
												onClick={(e) => { e.stopPropagation(); onHunkAddQuickPick(i); }}
											>
												{listTree}
											</span>
										)}
									</span>
								</td>
								<td className="diff-line-content diff-hunk-content-flex">
									<span className="diff-hunk-title">{line.content}</span>
								</td>
							</tr>
						);
					}

					const isCovered = !!coveredHeaderIndices?.has(currentHeaderIdx);
					if (hideCovered && isCovered) {
						return null;
					}
					const isSearchMatch = !!searchActive && !!searchMatchedLineIndices?.has(i);
					const isCollapsed = searchActive && !!searchMatchedHeaderIndices?.has(currentHeaderIdx)
						? false
						: (collapsedState[currentHeaderIdx] !== undefined ? collapsedState[currentHeaderIdx] : isCovered);

					if (isCollapsed) {
						return null;
					}

					const isHighlighted = !!highlightedLineIndices?.has(i);
					const rowMouseDown = highlightMode && onHighlightDragStart
						? (e: React.MouseEvent) => {
							if (e.button !== 0) return;
							e.preventDefault();
							onHighlightDragStart(i);
						}
						: undefined;
					const rowMouseEnter = highlightMode && onHighlightDragEnter
						? () => onHighlightDragEnter(i)
						: undefined;
					const rowMouseUp = highlightMode && onHighlightDragEnd
						? () => onHighlightDragEnd()
						: undefined;

					const showAddCommentButton = !!onAddCommentForLine;
					const threadWidget = threadWidgetsByLineIdx?.get(i);
					const showComposer = composerLineIdx === i && composerNode;
					return (
						<React.Fragment key={i}>
							<tr
								className={`diff-line diff-${line.type}${isCovered ? ' diff-hunk-covered' : ''}${isSearchMatch ? ' diff-search-match' : ''}${isHighlighted ? ' diff-line-highlighted' : ''}${showAddCommentButton ? ' diff-line-commentable' : ''}`}
								onMouseDown={rowMouseDown}
								onMouseEnter={rowMouseEnter}
								onMouseUp={rowMouseUp}
							>
								<td className="diff-line-num diff-line-num-left">
									{showAddCommentButton && (
										<button
											type="button"
											className="diff-add-comment-btn"
											title="Add comment on this line"
											onMouseDown={e => e.stopPropagation()}
											onClick={e => { e.stopPropagation(); onAddCommentForLine!(i); }}
										>
											+
										</button>
									)}
									<span className="diff-line-num-text">{line.type !== 'add' && line.oldLine !== undefined ? line.oldLine : ''}</span>
									{isHighlighted && onRemoveHighlightForRow && (
										<button
											type="button"
											className="diff-highlight-remove"
											title="Remove highlight"
											onMouseDown={e => e.stopPropagation()}
											onClick={e => { e.stopPropagation(); onRemoveHighlightForRow(i); }}
										>
											&times;
										</button>
									)}
								</td>
								<td className="diff-line-num">
									{line.type !== 'delete' && line.newLine !== undefined ? line.newLine : ''}
								</td>
								<td className="diff-line-content">
									<span className="diff-line-prefix">
										{line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' '}
									</span>
									{line.content}
								</td>
							</tr>
							{threadWidget && (
								<tr className="diff-thread-row">
									<td colSpan={3}>{threadWidget}</td>
								</tr>
							)}
							{showComposer && (
								<tr className="diff-thread-row">
									<td colSpan={3}>{composerNode}</td>
								</tr>
							)}
						</React.Fragment>
					);
				})}
			</tbody>
		</table>
	);
}
