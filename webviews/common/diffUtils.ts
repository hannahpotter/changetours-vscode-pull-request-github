/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface ParsedDiffLine {
	type: 'context' | 'add' | 'delete' | 'hunk-header';
	content: string;
	oldLine?: number;
	newLine?: number;
}

export function parsePatch(patch: string): ParsedDiffLine[] {
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
