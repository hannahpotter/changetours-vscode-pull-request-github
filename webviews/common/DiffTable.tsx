/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
import { ParsedDiffLine } from './diffUtils';
import { addIcon, listTree } from '../components/icon';

interface DiffTableProps {
	lines: ParsedDiffLine[];
	onHunkHeaderDragStart?: (e: React.DragEvent, headerIdx: number) => void;
	onHunkAddActive?: (headerIdx: number) => void;
	onHunkAddQuickPick?: (headerIdx: number) => void;
	activeNodeContext?: string;
	coveredHeaderIndices?: Set<number>;
}

export function DiffTable({ lines, onHunkHeaderDragStart, onHunkAddActive, onHunkAddQuickPick, activeNodeContext, coveredHeaderIndices }: DiffTableProps) {
	let currentHeaderIdx = -1;

	return (
		<table className="diff-table">
			<tbody>
				{lines.map((line, i) => {
					if (line.type === 'hunk-header') {
						currentHeaderIdx = i;
						const draggable = !!onHunkHeaderDragStart;
						const isCovered = coveredHeaderIndices?.has(currentHeaderIdx);
						return (
							<tr
								key={i}
								className={`diff-line diff-hunk-header${draggable ? ' draggable-hunk' : ''}${isCovered ? ' diff-hunk-covered' : ''}`}
								draggable={draggable || undefined}
								onDragStart={draggable ? e => onHunkHeaderDragStart!(e, i) : undefined}
								title={draggable ? 'Drag this hunk into a Code Tour editor' : undefined}
							>
								<td className="diff-line-num"></td>
								<td className="diff-line-num"></td>
								<td className="diff-line-content diff-hunk-content-flex">
									<span className="diff-hunk-title">{line.content}</span>
									<span className="diff-hunk-actions">
										{onHunkAddActive && (
											<span
												className="icon-button"
												title={activeNodeContext ? `Insert after: ${activeNodeContext}` : 'Append to end of tour'}
												onClick={(e) => { e.stopPropagation(); onHunkAddActive(i); }}
											>
												{addIcon}
											</span>
										)}
										{onHunkAddQuickPick && (
											<span
												className="icon-button"
												title="Add Hunk to Section..."
												onClick={(e) => { e.stopPropagation(); onHunkAddQuickPick(i); }}
											>
												{listTree}
											</span>
										)}
									</span>
								</td>
							</tr>
						);
					}

					const isCovered = coveredHeaderIndices?.has(currentHeaderIdx);
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
