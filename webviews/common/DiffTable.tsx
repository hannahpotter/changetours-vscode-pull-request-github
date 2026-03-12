/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
import { ParsedDiffLine } from './diffUtils';

interface DiffTableProps {
	lines: ParsedDiffLine[];
	onHunkHeaderDragStart?: (e: React.DragEvent, headerIdx: number) => void;
}

export function DiffTable({ lines, onHunkHeaderDragStart }: DiffTableProps) {
	return (
		<table className="diff-table">
			<tbody>
				{lines.map((line, i) => {
					if (line.type === 'hunk-header') {
						const draggable = !!onHunkHeaderDragStart;
						return (
							<tr
								key={i}
								className={`diff-line diff-hunk-header${draggable ? ' draggable-hunk' : ''}`}
								draggable={draggable || undefined}
								onDragStart={draggable ? e => onHunkHeaderDragStart!(e, i) : undefined}
								title={draggable ? 'Drag this hunk into a Code Tour editor' : undefined}
							>
								<td className="diff-line-num"></td>
								<td className="diff-line-num"></td>
								<td className="diff-line-content">{line.content}</td>
							</tr>
						);
					}
					return (
						<tr key={i} className={`diff-line diff-${line.type}`}>
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
