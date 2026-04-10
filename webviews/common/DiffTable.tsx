/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
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
	selectedHeaderIndices?: Set<number>;
	onHunkSelectToggle?: (headerIdx: number, selected: boolean) => void;
	selectedHunksCount?: number;
}

export function DiffTable({ lines, onHunkHeaderDragStart, onHunkAddActive, onHunkAddQuickPick, activeNodeContext, coveredHeaderIndices, selectedHeaderIndices, onHunkSelectToggle, selectedHunksCount }: DiffTableProps) {
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
						const isCollapsed = collapsedState[currentHeaderIdx] !== undefined ? collapsedState[currentHeaderIdx] : isCovered;

						return (
							<tr
								key={i}
								className={`diff-line diff-hunk-header${draggable ? ' draggable-hunk' : ''}${isCovered ? ' diff-hunk-covered' : ''}`}
								draggable={draggable || undefined}
								onDragStart={draggable ? e => onHunkHeaderDragStart!(e, i) : undefined}
								title={draggable ? 'Drag this hunk into a Code Tour editor' : undefined}
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
					const isCollapsed = collapsedState[currentHeaderIdx] !== undefined ? collapsedState[currentHeaderIdx] : isCovered;

					if (isCollapsed) {
						return null;
					}

					return (
						<tr key={i} className={`diff-line diff-${line.type}${isCovered ? ' diff-hunk-covered' : ''}`}>
							<td className="diff-line-num">
								{line.type !== 'add' && line.oldLine !== undefined ? line.oldLine : ''}
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
					);
				})}
			</tbody>
		</table>
	);
}
