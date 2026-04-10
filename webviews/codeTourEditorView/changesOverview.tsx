/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { HunkReference } from '../../src/github/codeTourMarkdown';
import { ChangedFileInfo } from '../../src/github/views';
import { DiffTable } from '../common/DiffTable';
import { ParsedDiffLine, parsePatch } from '../common/diffUtils';
import { addIcon, chevronDownIcon, listTree } from '../components/icon';

interface ChangedFilesOverviewProps {
	title: string;
	number: number;
	owner: string;
	repo: string;
	baseRef: string;
	files: ChangedFileInfo[];
	onHunkAdd: (hunks: HunkReference[], mode: 'active' | 'quickpick') => void;
	activeNodeContext?: string;
	codeTourHunks?: HunkReference[];
	onAddAllMissing?: (hunks: HunkReference[]) => void;
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

function DiffView({ patch, fileName, previousFile, prNumber, prOwner, prRepo, baseRef, onHunkAdd, activeNodeContext, coveredHunksSet, selectedHunksSet, onHunkSelect, onClearHunksSelection }: { patch: string; fileName: string; previousFile?: string; prNumber: number; prOwner: string; prRepo: string; baseRef: string, onHunkAdd: (hunks: HunkReference[], mode: 'active' | 'quickpick') => void, activeNodeContext?: string, coveredHunksSet?: Set<string>, selectedHunksSet: Set<string>, onHunkSelect: (k: string, s: boolean) => void, onClearHunksSelection: () => void }) {
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
			previousFile,
			isPR: true,
			baseRef,
			prNumber,
			prOwner,
			prRepo
		});
		e.dataTransfer.setData('application/vnd.codetour.hunk+json', payload);
		e.dataTransfer.effectAllowed = 'copy';
	}, [hunkRanges, fileName, lines, rawLines, hunkRawIndices, previousFile, baseRef, prNumber, prOwner, prRepo]);

	// Figure out which lines belong to covered & selected hunks so we can style/manage them
	const coveredHeaderIndices = new Set<number>();
	const selectedHeaderIndices = new Set<number>();
	hunkRanges.forEach((range, headerIdx) => {
		const key = `${fileName}:${range.startLine}:${range.endLine}`;
		if (coveredHunksSet?.has(key)) {
			coveredHeaderIndices.add(headerIdx);
		}
		if (selectedHunksSet.has(key)) {
			selectedHeaderIndices.add(headerIdx);
		}
	});

	const addHunkToEditor = useCallback((headerIdx: number, mode: 'active' | 'quickpick') => {
		const range = hunkRanges.get(headerIdx);
		if (!range) return;

		if (selectedHeaderIndices.has(headerIdx)) {
			const payloads: any[] = [];
			hunkRanges.forEach((r, idx) => {
				if (selectedHeaderIndices.has(idx)) {
					const parsedHunkIdx = lines.slice(0, idx + 1).filter(l => l.type === 'hunk-header').length - 1;
					const rawStart = hunkRawIndices[parsedHunkIdx];
					const rawEnd = parsedHunkIdx + 1 < hunkRawIndices.length
						? hunkRawIndices[parsedHunkIdx + 1]
						: rawLines.length;
					const hunkPatch = rawLines.slice(rawStart, rawEnd).join('\n');

					payloads.push({
						file: fileName,
						startLine: r.startLine,
						endLine: r.endLine,
						ref: 'HEAD',
						patch: hunkPatch,
						previousFile,
						isPR: true,
						baseRef,
						prNumber,
						prOwner,
						prRepo
					});
				}
			});
			onHunkAdd(payloads, mode);
			onClearHunksSelection();
		} else {
			const parsedHunkIdx = lines.slice(0, headerIdx + 1).filter(l => l.type === 'hunk-header').length - 1;
			const rawStart = hunkRawIndices[parsedHunkIdx];
			const rawEnd = parsedHunkIdx + 1 < hunkRawIndices.length
				? hunkRawIndices[parsedHunkIdx + 1]
				: rawLines.length;
			const hunkPatch = rawLines.slice(rawStart, rawEnd).join('\n');

			const payload = {
				file: fileName,
				startLine: range.startLine,
				endLine: range.endLine,
				ref: 'HEAD',
				patch: hunkPatch,
				previousFile,
				isPR: true,
				baseRef,
				prNumber,
				prOwner,
				prRepo
			};

			onHunkAdd([payload], mode);
		}
	}, [hunkRanges, fileName, lines, rawLines, hunkRawIndices, previousFile, baseRef, prNumber, prOwner, prRepo, onHunkAdd, selectedHeaderIndices, onClearHunksSelection]);

	const handleHunkSelectToggle = useCallback((headerIdx: number, selected: boolean) => {
		const range = hunkRanges.get(headerIdx);
		if (range) {
			onHunkSelect(`${fileName}:${range.startLine}:${range.endLine}`, selected);
		}
	}, [hunkRanges, fileName, onHunkSelect]);

	return (
		<DiffTable
			lines={lines}
			onHunkHeaderDragStart={handleHunkDragStart}
			onHunkAddActive={(headerIdx: number) => addHunkToEditor(headerIdx, 'active')}
			onHunkAddQuickPick={(headerIdx: number) => addHunkToEditor(headerIdx, 'quickpick')}
			activeNodeContext={activeNodeContext}
			coveredHeaderIndices={coveredHeaderIndices}
			selectedHeaderIndices={selectedHeaderIndices}
			onHunkSelectToggle={handleHunkSelectToggle}
			selectedHunksCount={selectedHeaderIndices.size}
		/>
	);
}

function FileEntry({ file, prNumber, prOwner, prRepo, baseRef, onHunkAdd, activeNodeContext, coveredHunksSet, fileMissingHunks, selectedHunksSet, onHunkSelect, onFileSelect, fileAllHunks }: { file: ChangedFileInfo, prNumber: number, prOwner: string, prRepo: string, baseRef: string, onHunkAdd: (hunks: HunkReference[], mode: 'active' | 'quickpick') => void, activeNodeContext?: string, coveredHunksSet?: Set<string>, fileMissingHunks: any[], selectedHunksSet: Set<string>, onHunkSelect: (k: string, s: boolean) => void, onFileSelect: (hunks: any[], s: boolean) => void, fileAllHunks: any[] }) {
	const allCovered = fileMissingHunks.length === 0;
	const [expanded, setExpanded] = useState(!allCovered);

	useEffect(() => {
		if (allCovered) {
			setExpanded(false);
		}
	}, [allCovered]);

	const { text, className } = statusLabel(file.status);
	const { dir, base } = splitPath(file.fileName);

	const selectedFileHunks = useMemo(() => {
		return fileAllHunks.filter((h: any) => selectedHunksSet.has(`${h.file}:${h.startLine}:${h.endLine}`));
	}, [fileAllHunks, selectedHunksSet]);

	const isAllSelected = fileAllHunks.length > 0 && selectedFileHunks.length === fileAllHunks.length;
	const isIndeterminate = selectedFileHunks.length > 0 && !isAllSelected;

	return (
		<div className="file-entry">
			<div className={`file-header ${allCovered ? 'file-covered' : ''}`} onClick={() => setExpanded(!expanded)}>
				<div className="file-actions">
					<span className={`expand-icon icon-button ${expanded ? '' : 'closed'}`} title={expanded ? 'Collapse file' : 'Expand file'}>{chevronDownIcon}</span>
					<div className="checkbox-wrapper">
						<input
							type="checkbox"
							title="Select file hunks"
							checked={isAllSelected}
							ref={r => { if (r) r.indeterminate = isIndeterminate; }}
							onChange={(e) => onFileSelect(fileAllHunks, e.target.checked)}
							onClick={(e) => e.stopPropagation()}
						/>
					</div>
					<span
						className="icon-button"
						title={`Insert ${selectedFileHunks.length} selected hunks${activeNodeContext ? ` after: ${activeNodeContext}` : ''}`}
						onClick={(e) => { e.stopPropagation(); onHunkAdd(selectedFileHunks, 'active'); onFileSelect(fileMissingHunks, false); }}
					>
						{addIcon}
					</span>
					<span
						className="icon-button"
						title={`Add ${selectedFileHunks.length} selected hunks to Section...`}
						onClick={(e) => { e.stopPropagation(); onHunkAdd(selectedFileHunks, 'quickpick'); onFileSelect(fileMissingHunks, false); }}
					>
						{listTree}
					</span>
				</div>
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
					<DiffView
						patch={file.patch}
						fileName={file.fileName}
						previousFile={file.previousFileName}
						prNumber={prNumber}
						prOwner={prOwner}
						prRepo={prRepo}
						baseRef={baseRef}
						onHunkAdd={onHunkAdd}
						activeNodeContext={activeNodeContext}
						coveredHunksSet={coveredHunksSet}
						selectedHunksSet={selectedHunksSet}
						onHunkSelect={onHunkSelect}
						onClearHunksSelection={() => onFileSelect(fileMissingHunks, false)}
					/>
				</div>
			)}
			{expanded && !file.patch && (
				<div className="file-diff no-diff">Binary file or no diff available</div>
			)}
		</div>
	);
}

export const ChangedFilesOverview = ({ title, number, owner, repo, baseRef, files, onHunkAdd, activeNodeContext, codeTourHunks = [], onAddAllMissing }: ChangedFilesOverviewProps) => {
	const totalAdditions = files.reduce((sum, f) => sum + (f.additions ?? 0), 0);
	const totalDeletions = files.reduce((sum, f) => sum + (f.deletions ?? 0), 0);
	const [selectedHunksSet, setSelectedHunksSet] = useState<Set<string>>(new Set());

	const handleHunkSelect = useCallback((hunkKey: string, selected: boolean) => {
		setSelectedHunksSet(prev => {
			const next = new Set(prev);
			if (selected) next.add(hunkKey);
			else next.delete(hunkKey);
			return next;
		});
	}, []);

	const handleFileSelect = useCallback((fileMissingHunks: any[], selected: boolean) => {
		setSelectedHunksSet(prev => {
			const next = new Set(prev);
			for (const h of fileMissingHunks) {
				const key = `${h.file}:${h.startLine}:${h.endLine}`;
				if (selected) next.add(key);
				else next.delete(key);
			}
			return next;
		});
	}, []);

	const coveredHunksSet = useMemo(() => {
		const set = new Set<string>();
		for (const ch of codeTourHunks) {
			set.add(`${ch.file}:${ch.startLine}:${ch.endLine}`);
		}
		return set;
	}, [codeTourHunks]);

	const { totalHunks, missingHunks, fileAllHunks } = useMemo(() => {
		let total = 0;
		const missing: any[] = [];
		const allHunksMap = new Map<string, any[]>();
		for (const file of files) {
			if (!file.patch) continue;
			const lines = parsePatch(file.patch);
			const rawLines = file.patch.split('\n');
			const ranges = computeHunkRanges(lines);

			const fileHunks: any[] = [];
			const hunkRawIndices: number[] = [];
			for (let i = 0; i < rawLines.length; i++) {
				if (rawLines[i].startsWith('@@')) {
					hunkRawIndices.push(i);
				}
			}

			for (const [headerIdx, range] of ranges.entries()) {
				total++;
				const hunkKey = `${file.fileName}:${range.startLine}:${range.endLine}`;

				const parsedHunkIdx = lines.slice(0, headerIdx + 1).filter(l => l.type === 'hunk-header').length - 1;
				const rawStart = hunkRawIndices[parsedHunkIdx];
				const rawEnd = parsedHunkIdx + 1 < hunkRawIndices.length
					? hunkRawIndices[parsedHunkIdx + 1]
					: rawLines.length;
				const hunkPatch = rawLines.slice(rawStart, rawEnd).join('\n');

				const hunkObj = {
					file: file.fileName,
					startLine: range.startLine,
					endLine: range.endLine,
					ref: 'HEAD',
					patch: hunkPatch,
					previousFile: file.previousFileName,
					isPR: true,
					baseRef,
					prNumber: number,
					prOwner: owner,
					prRepo: repo
				};

				fileHunks.push(hunkObj);

				if (!coveredHunksSet.has(hunkKey)) {
					missing.push(hunkObj);
				}
			}
			allHunksMap.set(file.fileName, fileHunks);
		}
		return { totalHunks: total, missingHunks: missing, fileAllHunks: allHunksMap };
	}, [files, coveredHunksSet, baseRef, number, owner, repo]);

	const coveredHunks = totalHunks - missingHunks.length;
	const progressPercent = totalHunks === 0 ? 0 : Math.round((coveredHunks / totalHunks) * 100);

	const allSelectedHunks = useMemo(() => {
		const allSelected: any[] = [];
		fileAllHunks.forEach((hunks) => {
			allSelected.push(...hunks.filter(h => selectedHunksSet.has(`${h.file}:${h.startLine}:${h.endLine}`)));
		});
		return allSelected;
	}, [fileAllHunks, selectedHunksSet]);

	return (
		<div className="code-tour-changes">
			<h2>All Changes for Code Tour &mdash; {title} <a>#{number}</a></h2>
			<div className="summary">
				{files.length} changed file{files.length !== 1 ? 's' : ''} with{' '}
				<span className="additions">+{totalAdditions}</span> and{' '}
				<span className="deletions">-{totalDeletions}</span>
			</div>
			{totalHunks > 0 && (
				<div className="exhaustiveness-check">
					<div className="exhaustiveness-header">
						<span>Covered Changes: {coveredHunks} / {totalHunks}</span>
						<div className="global-actions">
							<button
								disabled={allSelectedHunks.length === 0}
								onClick={() => {
									if (allSelectedHunks.length > 0) {
										onHunkAdd(allSelectedHunks, 'active');
										setSelectedHunksSet(new Set());
									}
								}}>
								{allSelectedHunks.length > 0 ? `Add ${allSelectedHunks.length} Selected` : 'Add Selected'}
							</button>
							{missingHunks.length > 0 && onAddAllMissing && (
								<button onClick={() => onAddAllMissing(missingHunks)}>Add All Missing</button>
							)}
						</div>
					</div>
					<div className="progress-bar-container">
						<div className="progress-bar" style={{ width: `${progressPercent}%` }} />
					</div>
				</div>
			)}
			<div className="changed-files-list">
				{files.map(file => {
					const fileMissingHunks = missingHunks.filter(h => h.file === file.fileName);
					return (
						<FileEntry
							key={file.fileName}
							file={file}
							prNumber={number}
							prOwner={owner}
							prRepo={repo}
							baseRef={baseRef}
							onHunkAdd={onHunkAdd}
							activeNodeContext={activeNodeContext}
							coveredHunksSet={coveredHunksSet}
							fileMissingHunks={fileMissingHunks}
							fileAllHunks={fileAllHunks.get(file.fileName) || []}
							selectedHunksSet={selectedHunksSet}
							onHunkSelect={handleHunkSelect}
							onFileSelect={handleFileSelect}
						/>
					);
				})}
			</div>
		</div>
	);
};