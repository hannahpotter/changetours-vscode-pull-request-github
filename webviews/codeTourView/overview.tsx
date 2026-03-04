/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
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

export const ChangedFilesOverview = ({ title, number, files }: ChangedFilesOverviewProps) => {
	const totalAdditions = files.reduce((sum, f) => sum + (f.additions ?? 0), 0);
	const totalDeletions = files.reduce((sum, f) => sum + (f.deletions ?? 0), 0);

	return (
		<>
			<h2>Changed Files - {title} <a>#{number}</a></h2>
			<div className="summary">
				{files.length} changed file{files.length !== 1 ? 's' : ''} with{' '}
				<span className="additions">+{totalAdditions}</span> and{' '}
				<span className="deletions">-{totalDeletions}</span>
			</div>
			<ul className="changed-files-list">
				{files.map(file => {
					const { text, className } = statusLabel(file.status);
					const { dir, base } = splitPath(file.fileName);
					return (
						<li key={file.fileName} className="changed-file-item">
							<span className={`file-status ${className}`}>{text}</span>
							<span className="file-name">
								<span className="file-path">{dir}</span>
								<span className="file-basename">{base}</span>
								{file.previousFileName && file.status === 'renamed' ? (
									<span className="file-path"> (from {file.previousFileName})</span>
								) : null}
							</span>
							{(file.additions !== undefined || file.deletions !== undefined) && (
								<span className="file-stats">
									{file.additions !== undefined && <span className="additions">+{file.additions}</span>}
									{file.additions !== undefined && file.deletions !== undefined && ' '}
									{file.deletions !== undefined && <span className="deletions">-{file.deletions}</span>}
								</span>
							)}
						</li>
					);
				})}
			</ul>
		</>
	);
};
