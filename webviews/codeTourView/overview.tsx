/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useState } from 'react';
import { DiffTable } from '../common/DiffTable';
import { parsePatch, ParsedDiffLine } from '../common/diffUtils';
import { ChangedFileInfo } from '../../src/github/views';

interface ChangedFilesOverviewProps {
	title: string;
	number: number;
	files: ChangedFileInfo[];
}

function statusLabel(status: string): { text: string; className: string } {
	switch (status) {
		case 'added': return { text: 'A', className: 'added' };
		case 'removed': return { text: 'D', className: 'removed' };
		case 'modified': return { text: 'M', className: 'modified' };
		case 'renamed': return { text: 'R', className: 'renamed' };
		case 'copied': return { text: 'C', className: 'modified' };
		default: return { text: 'M', className: 'modified' };
	}
}

function splitPath(fileName: string): { dir: string; base: string } {
	const lastSlash = fileName.lastIndexOf('/');
	if (lastSlash === -1) {
		return { dir: '', base: fileName };
	}
	return {
		dir: fileName.substring(0, lastSlash + 1),
		base: fileName.substring(lastSlash + 1),
	};
}

/**
 * Compute the line range covered by each hunk section so we can attach
 * drag data to hunk-header rows.
 */
function computeHunkRanges(lines: ParsedDiffLine[]): Map<number, { startLine: number; endLine: number }> {
	const ranges = new Map<number, { startLine: number; endLine: number }>();
	let currentHeaderIdx = -1;
	let startLine = 0;
	let endLine = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.type === 'hunk-header') {
			// Close previous hunk
			if (currentHeaderIdx >= 0) {
				ranges.set(currentHeaderIdx, { startLine, endLine });
			}
			currentHeaderIdx = i;
			const match = /^@@ -(?<start>\d+)/.exec(line.content);
			startLine = match ? parseInt(match.groups!.start, 10) : 0;
			endLine = startLine;
		} else {
			const ln = line.oldLine ?? line.newLine ?? endLine;
			if (ln > endLine) {
				endLine = ln;
			}
		}
	}
	if (currentHeaderIdx >= 0) {
		ranges.set(currentHeaderIdx, { startLine, endLine });
	}
	return ranges;
}

function DiffView({ patch, fileName }: { patch: string; fileName: string }) {
	const lines = parsePatch(patch);
	const rawLines = patch.split('\n');
	const hunkRanges = computeHunkRanges(lines);

	// Find the raw patch indices for each hunk header so we can extract hunk content
	const hunkRawIndices: number[] = [];
	for (let i = 0; i < rawLines.length; i++) {
		if (rawLines[i].startsWith('@@')) {
			hunkRawIndices.push(i);
		}
	}

	const handleHunkDragStart = useCallback((e: React.DragEvent, headerIdx: number) => {
		const range = hunkRanges.get(headerIdx);
		if (!range) {
			return;
		}

		// Extract the raw patch content for just this hunk
		const parsedHunkIdx = lines.slice(0, headerIdx + 1).filter(l => l.type === 'hunk-header').length - 1;
		const rawStart = hunkRawIndices[parsedHunkIdx];
		const rawEnd = parsedHunkIdx + 1 < hunkRawIndices.length
			? hunkRawIndices[parsedHunkIdx + 1]
			: rawLines.length;
		const hunkPatch = rawLines.slice(rawStart, rawEnd).join('\n');

		const payload = JSON.stringify({
			file: fileName,
			startLine: range.startLine,
			endLine: range.endLine,
			ref: 'HEAD',
			patch: hunkPatch,
		});
		e.dataTransfer.setData('application/vnd.codetour.hunk+json', payload);
		e.dataTransfer.effectAllowed = 'copy';
	}, [hunkRanges, fileName, lines, rawLines, hunkRawIndices]);

	return <DiffTable lines={lines} onHunkHeaderDragStart={handleHunkDragStart} />;
}

function FileEntry({ file }: { file: ChangedFileInfo }) {
	const [expanded, setExpanded] = useState(true);
	const { text, className } = statusLabel(file.status);
	const { dir, base } = splitPath(file.fileName);

	return (
		<div className="file-entry">
			<div className="file-header" onClick={() => setExpanded(!expanded)}>
				<span className={`expand-icon ${expanded ? 'expanded' : ''}`}>&#9656;</span>
				<span className={`file-status ${className}`}>{text}</span>
				<span className="file-name">
					<span className="file-basename">{base}</span>
					{dir && <span className="file-path">{dir}</span>}
					{file.previousFileName && file.status === 'renamed' ? (
						<span className="file-path"> &larr; {file.previousFileName}</span>
					) : null}
				</span>
				{(file.additions !== undefined || file.deletions !== undefined) && (
					<span className="file-stats">
						{file.additions !== undefined && <span className="additions">+{file.additions}</span>}
						{file.additions !== undefined && file.deletions !== undefined && ' '}
						{file.deletions !== undefined && <span className="deletions">-{file.deletions}</span>}
					</span>
				)}
			</div>
			{expanded && file.patch && (
				<div className="file-diff">
					<DiffView patch={file.patch} fileName={file.fileName} />
				</div>
			)}
			{expanded && !file.patch && (
				<div className="file-diff no-diff">Binary file or no diff available</div>
			)}
		</div>
	);
}

export const ChangedFilesOverview = ({ title, number, files }: ChangedFilesOverviewProps) => {
	const totalAdditions = files.reduce((sum, f) => sum + (f.additions ?? 0), 0);
	const totalDeletions = files.reduce((sum, f) => sum + (f.deletions ?? 0), 0);

	return (
		<>
			<h2>Code Tour &mdash; {title} <a>#{number}</a></h2>
			<div className="summary">
				{files.length} changed file{files.length !== 1 ? 's' : ''} with{' '}
				<span className="additions">+{totalAdditions}</span> and{' '}
				<span className="deletions">-{totalDeletions}</span>
			</div>
			<div className="changed-files-list">
				{files.map(file => (
					<FileEntry key={file.fileName} file={file} />
				))}
			</div>
		</>
	);
};
