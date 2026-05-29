/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export const CHANGE_TOUR_DIRNAME = '.changetour';
export const CHANGE_TOUR_EXT = '.changetour.md';

/**
 * Sanitize a PR title into a filesystem-safe segment.
 * Lowercases, replaces whitespace + path-illegal chars with '-',
 * collapses runs of '-', and clips to a reasonable length.
 */
export function sanitizePrTitleForFilename(title: string): string {
	return title
		.toLowerCase()
		.replace(/[\s/\\:*?"<>|]+/g, '-')
		.replace(/[^a-z0-9._-]/g, '')
		.replace(/-+/g, '-')
		.replace(/^[-_.]+|[-_.]+$/g, '')
		.slice(0, 80);
}

/**
 * Canonical path for a PR's change tour file:
 *   <workspaceRoot>/.changetour/<prNumber>-<sanitized-title>.changetour.md
 * If the sanitized title is empty (very unusual titles), falls back to
 *   <workspaceRoot>/.changetour/<prNumber>.changetour.md
 */
export function getChangeTourUri(workspaceRoot: vscode.Uri, prNumber: number, prTitle: string): vscode.Uri {
	const sanitized = sanitizePrTitleForFilename(prTitle);
	const filename = sanitized
		? `${prNumber}-${sanitized}${CHANGE_TOUR_EXT}`
		: `${prNumber}${CHANGE_TOUR_EXT}`;
	return vscode.Uri.joinPath(workspaceRoot, CHANGE_TOUR_DIRNAME, filename);
}

/**
 * Find an existing change tour for a PR, tolerant of title renames.
 * Scans the `.changetour/` directory for any file whose name starts with
 * `<prNumber>-` or matches `<prNumber>.changetour.md` exactly.
 * Returns the first match (canonical title first if both exist).
 */
export async function findExistingChangeTour(
	workspaceRoot: vscode.Uri,
	prNumber: number,
	prTitle?: string,
): Promise<vscode.Uri | undefined> {
	const dir = vscode.Uri.joinPath(workspaceRoot, CHANGE_TOUR_DIRNAME);
	let entries: [string, vscode.FileType][];
	try {
		entries = await vscode.workspace.fs.readDirectory(dir);
	} catch {
		return undefined;
	}

	const exact = `${prNumber}${CHANGE_TOUR_EXT}`;
	const prefix = `${prNumber}-`;
	const canonicalName = prTitle ? (() => {
		const s = sanitizePrTitleForFilename(prTitle);
		return s ? `${prNumber}-${s}${CHANGE_TOUR_EXT}` : undefined;
	})() : undefined;

	let exactMatch: string | undefined;
	let prefixMatch: string | undefined;
	let canonicalMatch: string | undefined;

	for (const [name, type] of entries) {
		if (type !== vscode.FileType.File) {
			continue;
		}
		if (canonicalName && name === canonicalName) {
			canonicalMatch = name;
		} else if (name === exact) {
			exactMatch = name;
		} else if (name.startsWith(prefix) && name.endsWith(CHANGE_TOUR_EXT)) {
			prefixMatch ??= name;
		}
	}

	const winner = canonicalMatch ?? exactMatch ?? prefixMatch;
	return winner ? vscode.Uri.joinPath(dir, winner) : undefined;
}

/**
 * Ensure the `.changetour/` directory exists at the workspace root.
 */
export async function ensureChangeTourDir(workspaceRoot: vscode.Uri): Promise<void> {
	const dir = vscode.Uri.joinPath(workspaceRoot, CHANGE_TOUR_DIRNAME);
	try {
		await vscode.workspace.fs.createDirectory(dir);
	} catch {
		// createDirectory is idempotent for existing dirs in VS Code's FS API.
	}
}
