/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useState } from 'react';
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

interface ParsedDiffLine {
	type: 'context' | 'add' | 'delete' | 'hunk-header';
	content: string;
	oldLine?: number;
	newLine?: number;
}

function parsePatch(patch: string): ParsedDiffLine[] {
	const lines = patch.split('\n');
	const result: ParsedDiffLine[] = [];
	let oldLine = 0;
	let newLine = 0;

	for (const line of lines) {
		if (line.startsWith('@@')) {
			const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/.exec(line);
			if (match) {
				oldLine = parseInt(match[1], 10);
				newLine = parseInt(match[2], 10);
			}
			result.push({ type: 'hunk-header', content: line });
		} else if (line.startsWith('+')) {
			result.push({ type: 'add', content: line.substring(1), newLine });
			newLine++;
		} else if (line.startsWith('-')) {
			result.push({ type: 'delete', content: line.substring(1), oldLine });
			oldLine++;
		} else if (line.startsWith(' ')) {
			result.push({ type: 'context', content: line.substring(1), oldLine, newLine });
			oldLine++;
			newLine++;
		} else if (line.startsWith('\\')) {
			result.push({ type: 'context', content: line });
		}
	}
	return result;
}

function DiffView({ patch }: { patch: string }) {
	const lines = parsePatch(patch);

	return (
		<table className="diff-table">
			<tbody>
				{lines.map((line, i) => {
					if (line.type === 'hunk-header') {
						return (
							<tr key={i} className="diff-line diff-hunk-header">
								<td className="diff-line-num"></td>
								<td className="diff-line-num"></td>
								<td className="diff-line-content">{line.content}</td>
							</tr>
						);
					}
					return (
						<tr key={i} className={`diff-line diff-${line.type}`}>
							<td className="diff-line-num">{line.type !== 'add' && line.oldLine !== undefined ? line.oldLine : ''}</td>
							<td className="diff-line-num">{line.type !== 'delete' && line.newLine !== undefined ? line.newLine : ''}</td>
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
					<DiffView patch={file.patch} />
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
