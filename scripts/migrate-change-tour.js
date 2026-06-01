/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * One-shot migration for `.changetour.md` files: rewrites the legacy
 * `:::hunk … :::` directive format to the new `<details>`-wrapped format
 * that renders cleanly in standard markdown viewers (GitHub, VS Code preview).
 *
 * Usage:
 *   node scripts/migrate-change-tour.js <path> [<path> …] [--in-place]
 *
 * By default the migrated content is written to a sibling `.new` file so the
 * caller can diff it before committing. Pass `--in-place` to overwrite the
 * original.
 *
 * Best-effort fields: `schemaVersion` is added, and `baseSha` / `headSha` are
 * stamped as `TODO` placeholders in the frontmatter, plus `baseBlob` is stamped
 * as `TODO` in each hunk's metadata comment. The author-time SHAs are not
 * recoverable from disk - the placeholders are visible enough to be noticed
 * during the upgrade and patched by hand (or by the PR-binding step in the
 * extension), but the migrated tour still parses and renders correctly.
 *
 * This script is intentionally dependency-free so it runs anywhere Node does.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const LEGACY_HUNK_OPEN_RE = /^:::hunk\s+(.*)$/;
const LEGACY_HUNK_CLOSE_RE = /^:::$/;
const FRONTMATTER_DELIM_RE = /^---\s*$/;
const TODO_PLACEHOLDER = 'TODO-rerun-PR-binding';

/**
 * Tokenize the attribute list of a legacy `:::hunk` directive. Same grammar
 * as the in-extension parser - bare tokens or `"quoted strings"` with `\"` /
 * `\\` escapes.
 */
function parseHunkAttributes(rest) {
	const attrs = {};
	const re = /(\w+)=(?:"((?:\\.|[^"\\])*)"|([^\s]+))/g;
	let m;
	while ((m = re.exec(rest)) !== null) {
		const key = m[1];
		attrs[key] = m[2] !== undefined ? m[2].replace(/\\(["\\])/g, '$1') : m[3];
	}
	return attrs;
}

function serializeAttributeValue(value) {
	if (value.length > 0 && !/[\s"\\]/.test(value)) {
		return value;
	}
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function escapeHtml(s) {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Get a 1-line summary for the rebuilt `<summary>`. Mirrors `getHunkSummary`
 * in src/github/codeTourMarkdown.ts: prefer the authored `summary` attr,
 * otherwise pull the first changed line of the patch.
 */
function deriveSummary(authored, patchLines) {
	if (authored && authored.trim().length > 0) {
		return authored.trim();
	}
	for (const line of patchLines) {
		if (line.startsWith('@@') || line.length === 0) {
			continue;
		}
		if (line.startsWith('+') || line.startsWith('-')) {
			const content = line.substring(1).trim();
			if (content.length > 0) {
				return content.length <= 60 ? content : content.substring(0, 59).trimEnd() + '…';
			}
		}
	}
	return '';
}

/**
 * Build the new `<details>` block from a parsed legacy hunk.
 */
function buildDetailsBlock(attrs, patchLines, baseBlobPlaceholder) {
	const out = [];
	const defaultCollapsed = attrs.defaultCollapsed === 'true';
	out.push(defaultCollapsed ? '<details>' : '<details open>');

	const summaryText = deriveSummary(attrs.summary, patchLines);
	const pathHtml = attrs.previousFile && attrs.previousFile !== attrs.file
		? `<code>${escapeHtml(attrs.previousFile)}</code> → <code>${escapeHtml(attrs.file)}</code>`
		: `<code>${escapeHtml(attrs.file)}</code>`;
	out.push(`<summary>${pathHtml}${summaryText ? ' · ' + escapeHtml(summaryText) : ''}</summary>`);
	out.push('');

	const metaParts = [`file=${serializeAttributeValue(attrs.file)}`];
	if (attrs.previousFile) metaParts.push(`previousFile=${serializeAttributeValue(attrs.previousFile)}`);
	if (attrs.level) metaParts.push(`level=${attrs.level}`);
	if (attrs.highlights) metaParts.push(`highlights=${attrs.highlights}`);
	if (attrs.summary && attrs.summary.trim().length > 0) {
		metaParts.push(`summary=${serializeAttributeValue(attrs.summary)}`);
	}
	metaParts.push(`baseBlob=${baseBlobPlaceholder}`);
	out.push(`<!-- changetour:hunk ${metaParts.join(' ')} -->`);
	out.push('');

	out.push('```diff');
	for (const line of patchLines) {
		out.push(line);
	}
	out.push('```');
	out.push('');
	out.push('</details>');
	return out;
}

/**
 * Migrate one tour's text. Returns { migrated: string, hunkCount: number }.
 * Throws on structural problems that prevent a safe rewrite (e.g. unclosed
 * `:::hunk` blocks).
 */
function migrateText(text) {
	const lines = text.split('\n');
	const out = [];
	let hunkCount = 0;

	// ----- Frontmatter pass --------------------------------------------------
	let i = 0;
	if (lines[0] && FRONTMATTER_DELIM_RE.test(lines[0])) {
		out.push(lines[0]);
		i = 1;
		const fmKeys = new Set();
		while (i < lines.length && !FRONTMATTER_DELIM_RE.test(lines[i])) {
			const match = /^([a-zA-Z0-9_]+)\s*:\s*(.+)$/.exec(lines[i]);
			if (match) {
				fmKeys.add(match[1]);
			}
			out.push(lines[i]);
			i++;
		}
		// Stamp new keys before the closing `---` so they sit alongside the
		// existing PR metadata. Use placeholder SHAs that the author (or the
		// extension's tour-binding step) can patch later.
		if (!fmKeys.has('schemaVersion')) out.push('schemaVersion: 1');
		if (!fmKeys.has('baseSha')) out.push(`baseSha: ${TODO_PLACEHOLDER}`);
		if (!fmKeys.has('headSha')) out.push(`headSha: ${TODO_PLACEHOLDER}`);
		if (i < lines.length) {
			out.push(lines[i]); // closing ---
			i++;
		}
	}

	// ----- Body pass ---------------------------------------------------------
	while (i < lines.length) {
		const openMatch = LEGACY_HUNK_OPEN_RE.exec(lines[i]);
		if (!openMatch) {
			out.push(lines[i]);
			i++;
			continue;
		}

		const attrs = parseHunkAttributes(openMatch[1]);
		if (!attrs.file) {
			throw new Error(`Line ${i + 1}: legacy :::hunk directive missing file= attribute.`);
		}
		i++;

		const patchLines = [];
		let closed = false;
		while (i < lines.length) {
			if (LEGACY_HUNK_CLOSE_RE.test(lines[i])) {
				closed = true;
				i++;
				break;
			}
			patchLines.push(lines[i]);
			i++;
		}
		if (!closed) {
			throw new Error(`Unclosed :::hunk block for file=${attrs.file}.`);
		}
		while (patchLines.length > 0 && patchLines[patchLines.length - 1].trim() === '') {
			patchLines.pop();
		}

		for (const blockLine of buildDetailsBlock(attrs, patchLines, TODO_PLACEHOLDER)) {
			out.push(blockLine);
		}
		hunkCount++;
	}

	return { migrated: out.join('\n').replace(/\n+$/, '\n'), hunkCount };
}

/* ----- CLI --------------------------------------------------------------- */

function printHelp() {
	console.error('Usage: node migrate-change-tour.js <path> [<path> …] [--in-place]');
	console.error('');
	console.error('Rewrites .changetour.md files from the legacy :::hunk format to the');
	console.error(`new <details>-wrapped format. Adds schemaVersion=1 plus baseSha/headSha/baseBlob`);
	console.error(`as "${TODO_PLACEHOLDER}" placeholders that the PR-binding step (or a`);
	console.error('hand edit) will fill in. By default writes to <path>.new; pass --in-place');
	console.error('to overwrite the original.');
}

function main(argv) {
	const args = { paths: [], inPlace: false, help: false };
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--in-place') {
			args.inPlace = true;
		} else if (a === '-h' || a === '--help') {
			args.help = true;
		} else {
			args.paths.push(a);
		}
	}
	if (args.help || args.paths.length === 0) {
		printHelp();
		process.exit(args.help ? 0 : 2);
	}

	let totalHunks = 0;
	for (const p of args.paths) {
		const absPath = path.resolve(p);
		if (!fs.existsSync(absPath)) {
			console.error(`Not found: ${absPath}`);
			process.exit(1);
		}
		const text = fs.readFileSync(absPath, 'utf8');
		let result;
		try {
			result = migrateText(text);
		} catch (err) {
			console.error(`${absPath}: migration failed: ${err.message}`);
			process.exit(1);
		}
		const outPath = args.inPlace ? absPath : absPath + '.new';
		fs.writeFileSync(outPath, result.migrated, 'utf8');
		totalHunks += result.hunkCount;
		console.log(`${absPath} → ${outPath} (${result.hunkCount} hunk(s) rewritten)`);
	}
	console.log(`\nDone. ${totalHunks} hunk(s) across ${args.paths.length} file(s).`);
	if (!args.inPlace) {
		console.log('Review the .new files, then either rename them over the originals or re-run with --in-place.');
	}
}

if (require.main === module) {
	main(process.argv);
}

module.exports = { migrateText };
