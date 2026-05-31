/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useState } from 'react';
import { ParsedDiffLine } from './diffUtils';
import { addIcon, chevronDownIcon, listTree } from '../components/icon';

interface DiffTableProps {
	lines: ParsedDiffLine[];
	layout?: 'inline' | 'sideBySide';
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

export function DiffTable(props: DiffTableProps) {
	if (props.layout === 'sideBySide') {
		return <DiffTableSideBySide {...props} />;
	}
	return <DiffTableInline {...props} />;
}

function DiffTableInline({ lines, onHunkHeaderDragStart, onHunkAddActive, onHunkAddQuickPick, activeNodeContext, coveredHeaderIndices, hideCovered, selectedHeaderIndices, searchActive, searchMatchedHeaderIndices, searchMatchedLineIndices, onHunkSelectToggle, selectedHunksCount, highlightedLineIndices, highlightMode, onHighlightDragStart, onHighlightDragEnter, onHighlightDragEnd, onRemoveHighlightForRow, onAddCommentForLine, composerLineIdx, composerNode, threadWidgetsByLineIdx }: DiffTableProps) {
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

/* ------------------------------------------------------------------------- *
 * Side-by-side renderer.
 *
 * Walks the parsed lines and builds paired rows: contiguous runs of deletes
 * followed by adds are zipped so they sit on opposite sides of the same row,
 * with blank fills when the counts don't match. Context lines render
 * identically on both sides; hunk headers span the full row.
 * ------------------------------------------------------------------------- */

type SideBySideRow =
	| { kind: 'header'; idx: number; line: ParsedDiffLine }
	| { kind: 'context'; idx: number; line: ParsedDiffLine }
	| { kind: 'change'; leftIdx?: number; left?: ParsedDiffLine; rightIdx?: number; right?: ParsedDiffLine };

function buildSideBySideRows(lines: ParsedDiffLine[]): SideBySideRow[] {
	const rows: SideBySideRow[] = [];
	let i = 0;
	while (i < lines.length) {
		const ln = lines[i];
		if (ln.type === 'hunk-header') {
			rows.push({ kind: 'header', idx: i, line: ln });
			i++;
			continue;
		}
		if (ln.type === 'context') {
			rows.push({ kind: 'context', idx: i, line: ln });
			i++;
			continue;
		}
		const deletes: Array<{ idx: number; line: ParsedDiffLine }> = [];
		const adds: Array<{ idx: number; line: ParsedDiffLine }> = [];
		while (i < lines.length && lines[i].type === 'delete') {
			deletes.push({ idx: i, line: lines[i] });
			i++;
		}
		while (i < lines.length && lines[i].type === 'add') {
			adds.push({ idx: i, line: lines[i] });
			i++;
		}
		const n = Math.max(deletes.length, adds.length);
		for (let j = 0; j < n; j++) {
			const left = deletes[j];
			const right = adds[j];
			rows.push({
				kind: 'change',
				leftIdx: left?.idx,
				left: left?.line,
				rightIdx: right?.idx,
				right: right?.line,
			});
		}
	}
	return rows;
}

function DiffTableSideBySide({ lines, coveredHeaderIndices, hideCovered, highlightedLineIndices, highlightMode, onHighlightDragStart, onHighlightDragEnter, onHighlightDragEnd, onRemoveHighlightForRow, onAddCommentForLine, composerLineIdx, composerNode, threadWidgetsByLineIdx }: DiffTableProps) {
	const [collapsedState, setCollapsedState] = useState<{ [key: number]: boolean }>({});
	const rows = React.useMemo(() => buildSideBySideRows(lines), [lines]);

	// Determine which header each row belongs to, so collapse and hide-covered behave like the inline view.
	let currentHeader = -1;
	const rowHeaderIdx: number[] = [];
	for (const row of rows) {
		if (row.kind === 'header') {
			currentHeader = row.idx;
		}
		rowHeaderIdx.push(currentHeader);
	}

	const toggleCollapse = (idx: number, isCurrentlyCovered: boolean) => {
		setCollapsedState(prev => ({
			...prev,
			[idx]: prev[idx] !== undefined ? !prev[idx] : !isCurrentlyCovered,
		}));
	};

	const renderSide = (line: ParsedDiffLine | undefined, idx: number | undefined, side: 'left' | 'right') => {
		if (!line) {
			return (
				<>
					<td className="diff-line-num diff-line-num-empty" />
					<td className="diff-line-content diff-line-empty" />
				</>
			);
		}
		const showAddCommentButton = !!onAddCommentForLine && idx !== undefined;
		const isHighlighted = idx !== undefined && !!highlightedLineIndices?.has(idx);
		const cellMouseDown = highlightMode && onHighlightDragStart && idx !== undefined
			? (e: React.MouseEvent) => {
				if (e.button !== 0) return;
				e.preventDefault();
				onHighlightDragStart(idx);
			}
			: undefined;
		const cellMouseEnter = highlightMode && onHighlightDragEnter && idx !== undefined
			? () => onHighlightDragEnter(idx)
			: undefined;
		const cellMouseUp = highlightMode && onHighlightDragEnd ? () => onHighlightDragEnd() : undefined;
		const lineNum = side === 'left'
			? (line.type !== 'add' && line.oldLine !== undefined ? line.oldLine : '')
			: (line.type !== 'delete' && line.newLine !== undefined ? line.newLine : '');
		return (
			<>
				<td
					className={`diff-line-num diff-line-num-${side}${showAddCommentButton ? ' diff-line-commentable' : ''}`}
					onMouseDown={cellMouseDown}
					onMouseEnter={cellMouseEnter}
					onMouseUp={cellMouseUp}
				>
					{showAddCommentButton && (
						<button
							type="button"
							className="diff-add-comment-btn"
							title="Add comment on this line"
							onMouseDown={e => e.stopPropagation()}
							onClick={e => { e.stopPropagation(); onAddCommentForLine!(idx!); }}
						>
							+
						</button>
					)}
					<span className="diff-line-num-text">{lineNum}</span>
					{isHighlighted && onRemoveHighlightForRow && idx !== undefined && (
						<button
							type="button"
							className="diff-highlight-remove"
							title="Remove highlight"
							onMouseDown={e => e.stopPropagation()}
							onClick={e => { e.stopPropagation(); onRemoveHighlightForRow(idx); }}
						>
							&times;
						</button>
					)}
				</td>
				<td
					className={`diff-line-content diff-${line.type}`}
					onMouseDown={cellMouseDown}
					onMouseEnter={cellMouseEnter}
					onMouseUp={cellMouseUp}
				>
					<span className="diff-line-prefix">
						{line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' '}
					</span>
					{line.content}
				</td>
			</>
		);
	};

	return (
		<table className="diff-table diff-table-side-by-side">
			<colgroup>
				<col className="diff-col-num" style={{ width: 48 }} />
				<col className="diff-col-content" />
				<col className="diff-col-num" style={{ width: 48 }} />
				<col className="diff-col-content" />
			</colgroup>
			<tbody>
				{rows.map((row, rowI) => {
					const headerIdx = rowHeaderIdx[rowI];
					const isCovered = headerIdx >= 0 && !!coveredHeaderIndices?.has(headerIdx);
					if (hideCovered && isCovered) {
						return null;
					}

					if (row.kind === 'header') {
						const isCollapsed = collapsedState[row.idx] !== undefined ? collapsedState[row.idx] : isCovered;
						return (
							<tr key={`h-${row.idx}`} className={`diff-line diff-hunk-header${isCovered ? ' diff-hunk-covered' : ''}`}>
								<td className="diff-line-num diff-hunk-header-actions" style={{ width: 48 }}>
									<span className="diff-hunk-actions">
										<span
											className={`expand-icon icon-button ${isCollapsed ? 'closed' : ''}`}
											title={isCollapsed ? 'Expand hunk' : 'Collapse hunk'}
											onClick={(e) => { e.stopPropagation(); toggleCollapse(row.idx, isCovered); }}
										>
											{chevronDownIcon}
										</span>
									</span>
								</td>
								<td colSpan={3} className="diff-line-content diff-hunk-content-flex">
									<span className="diff-hunk-title">{row.line.content}</span>
								</td>
							</tr>
						);
					}

					const isCollapsed = headerIdx >= 0
						? (collapsedState[headerIdx] !== undefined ? collapsedState[headerIdx] : isCovered)
						: false;
					if (isCollapsed) {
						return null;
					}

					if (row.kind === 'context') {
						const ln = row.line;
						const isHighlighted = !!highlightedLineIndices?.has(row.idx);
						const threadWidget = threadWidgetsByLineIdx?.get(row.idx);
						const showComposer = composerLineIdx === row.idx && composerNode;
						return (
							<React.Fragment key={`c-${row.idx}`}>
								<tr className={`diff-line diff-context${isCovered ? ' diff-hunk-covered' : ''}${isHighlighted ? ' diff-line-highlighted' : ''}`}>
									<td className="diff-line-num diff-line-num-left">
										<span className="diff-line-num-text">{ln.oldLine ?? ''}</span>
									</td>
									<td className="diff-line-content diff-context">
										<span className="diff-line-prefix"> </span>
										{ln.content}
									</td>
									<td className="diff-line-num diff-line-num-right">
										<span className="diff-line-num-text">{ln.newLine ?? ''}</span>
									</td>
									<td className="diff-line-content diff-context">
										<span className="diff-line-prefix"> </span>
										{ln.content}
									</td>
								</tr>
								{threadWidget && (
									<tr className="diff-thread-row">
										<td colSpan={4}>{threadWidget}</td>
									</tr>
								)}
								{showComposer && (
									<tr className="diff-thread-row">
										<td colSpan={4}>{composerNode}</td>
									</tr>
								)}
							</React.Fragment>
						);
					}

					// change row
					const leftThread = row.leftIdx !== undefined ? threadWidgetsByLineIdx?.get(row.leftIdx) : undefined;
					const rightThread = row.rightIdx !== undefined ? threadWidgetsByLineIdx?.get(row.rightIdx) : undefined;
					const composerOnLeft = row.leftIdx !== undefined && composerLineIdx === row.leftIdx && composerNode;
					const composerOnRight = row.rightIdx !== undefined && composerLineIdx === row.rightIdx && composerNode;
					const leftHighlighted = row.leftIdx !== undefined && !!highlightedLineIndices?.has(row.leftIdx);
					const rightHighlighted = row.rightIdx !== undefined && !!highlightedLineIndices?.has(row.rightIdx);
					const rowClass = [
						'diff-line',
						'diff-line-change',
						isCovered ? 'diff-hunk-covered' : '',
						leftHighlighted ? 'diff-line-highlighted-left' : '',
						rightHighlighted ? 'diff-line-highlighted-right' : '',
					].filter(Boolean).join(' ');
					return (
						<React.Fragment key={`x-${row.leftIdx ?? 'e'}-${row.rightIdx ?? 'e'}`}>
							<tr className={rowClass}>
								{renderSide(row.left, row.leftIdx, 'left')}
								{renderSide(row.right, row.rightIdx, 'right')}
							</tr>
							{(leftThread || rightThread) && (
								<tr className="diff-thread-row">
									<td colSpan={4}>{leftThread ?? rightThread}</td>
								</tr>
							)}
							{(composerOnLeft || composerOnRight) && (
								<tr className="diff-thread-row">
									<td colSpan={4}>{composerNode}</td>
								</tr>
							)}
						</React.Fragment>
					);
				})}
			</tbody>
		</table>
	);
}
