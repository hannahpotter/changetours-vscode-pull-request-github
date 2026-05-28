/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ParsedDiffLine } from './diffUtils';
import type { HighlightRange } from '../../src/github/codeTourMarkdown';

export function indicesFromHighlights(lines: ParsedDiffLine[], highlights: HighlightRange[] | undefined): Set<number> {
	const set = new Set<number>();
	if (!highlights || highlights.length === 0) {
		return set;
	}
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.type === 'hunk-header') {
			continue;
		}
		for (const r of highlights) {
			if (r.side === 'new' && line.newLine !== undefined && line.newLine >= r.start && line.newLine <= r.end) {
				set.add(i);
				break;
			}
			if (r.side === 'old' && line.oldLine !== undefined && line.oldLine >= r.start && line.oldLine <= r.end) {
				set.add(i);
				break;
			}
		}
	}
	return set;
}
