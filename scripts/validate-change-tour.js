/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Standalone validator for .changetour.md files.
 *
 * Usage:
 *   node validate-change-tour.js <path-to-tour.changetour.md> [--skip-pr-check]
 *                                                           [--pr <number>]
 *                                                           [--repo <owner>/<repo>]
 *
 * Exits 0 if the tour is valid, 1 otherwise. Errors are printed to stderr in
 * a format that's easy to read in a terminal: `file:line: <level>: <message>`.
 *
 * Validation passes:
 *   1. Structural - frontmatter shape, title presence, hunk directive
 *      attributes, body presence + @@ header, balanced :::, highlight syntax.
 *   2. PR cross-check (optional) - if the tour has prNumber/prOwner/prRepo
 *      in frontmatter and `gh` is installed and authenticated, fetch the PR
 *      diff via `gh pr diff` and verify every hunk references a real
 *      file + line range in that diff. Skipped if --skip-pr-check is passed,
 *      if `gh` is missing, or if the fetch fails (in which case a warning is
 *      emitted instead of an error so offline workflows still pass).
 *
 * This script is intentionally dependency-free so it runs anywhere Node does.
 * It is bundled with the GitHub Pull Request extension and referenced from
 * the "Edit Change Tour with Claude Code" command so external agents (Claude
 * Code, hand-rolled scripts) can validate their output against the same shape
 * the in-extension LLM tools produce.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REQUIRED_FRONTMATTER_KEYS = ['schemaVersion', 'prNumber', 'prOwner', 'prRepo', 'baseSha', 'headSha'];
const RECOMMENDED_FRONTMATTER_KEYS = [];

// Permissive line-recognition regexes (allow leading whitespace so we can
// reliably *find* a hunk block even when the author indented it by accident).
// Indentation itself is reported as a separate error below - the in-extension
// parser tolerates leading whitespace but GitHub's renderer treats 4+ leading
// spaces as a code block, which silently breaks the entire <details> visual.
const DETAILS_OPEN_RE = /^\s*<details(\s+open)?\s*>\s*$/;
const DETAILS_CLOSE_RE = /^\s*<\/details>\s*$/;
const SUMMARY_LINE_RE = /^\s*<summary>.*<\/summary>\s*$/;
const HUNK_METADATA_RE = /^\s*<!--\s*changetour:hunk\s+(.*?)\s*-->\s*$/;
const DIFF_FENCE_OPEN_RE = /^\s*```diff\s*$/;
const DIFF_FENCE_CLOSE_RE = /^\s*```\s*$/;
const HAS_LEADING_WHITESPACE_RE = /^[ \t]+/;
const HUNK_HEADER_LINE_RE = /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/;
const HUNK_BODY_RANGE_RE = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/;
const LEGACY_HUNK_OPEN_RE = /^:::hunk(\s|$)/;

/* ----- Structural validation ----------------------------------------- */

/**
 * Tokenize the attribute list inside a `<!-- changetour:hunk … -->` comment.
 * Values can be bare tokens (`file=path/to/x.ts`) or double-quoted strings
 * (`summary="…"`). Inside a quoted value `\"` and `\\` are recognized as
 * escapes for `"` and `\`. Mirrors `parseHunkAttributes` in
 * src/github/codeTourMarkdown.ts.
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

/**
 * Validate a tour document's structure. Returns { errors, warnings,
 * frontmatter, hunks } where `hunks` is the list of (file, startLine,
 * endLine, openLine) entries discovered - used by the PR cross-check phase.
 */
function validateStructure(text) {
	const errors = [];
	const warnings = [];
	const hunks = [];
	const lines = text.split('\n');

	// ----- 1. Frontmatter -------------------------------------------------
	let inFrontmatter = false;
	let frontmatterStartLine = -1;
	let frontmatterEndLine = -1;
	const frontmatter = {};

	if (lines[0] && lines[0].trim() === '---') {
		inFrontmatter = true;
		frontmatterStartLine = 1;
		for (let i = 1; i < lines.length; i++) {
			if (lines[i].trim() === '---') {
				frontmatterEndLine = i + 1;
				inFrontmatter = false;
				break;
			}
			const match = /^([a-zA-Z0-9_]+)\s*:\s*(.+)$/.exec(lines[i]);
			if (match) {
				frontmatter[match[1]] = match[2].trim();
			}
		}
		if (inFrontmatter) {
			errors.push({
				line: frontmatterStartLine,
				message: 'Unterminated frontmatter - missing closing `---`.',
			});
		}
	} else {
		errors.push({
			line: 1,
			message: 'Missing frontmatter. The first line must be `---` followed by `schemaVersion`, `prNumber`, `prOwner`, `prRepo`, `baseSha`, `headSha`, closed by another `---`.',
		});
	}

	for (const key of REQUIRED_FRONTMATTER_KEYS) {
		if (!(key in frontmatter)) {
			errors.push({
				line: frontmatterEndLine > 0 ? frontmatterEndLine : 1,
				message: `Frontmatter is missing required key \`${key}\`. The bound pull request cannot be resolved without it.`,
			});
		}
	}
	for (const key of RECOMMENDED_FRONTMATTER_KEYS) {
		if (!(key in frontmatter)) {
			warnings.push({
				line: frontmatterEndLine > 0 ? frontmatterEndLine : 1,
				message: `Frontmatter is missing recommended key \`${key}\`.`,
			});
		}
	}

	if ('schemaVersion' in frontmatter && frontmatter.schemaVersion !== '1') {
		errors.push({
			line: frontmatterEndLine,
			message: `Frontmatter \`schemaVersion\` must be \`1\` (got \`${frontmatter.schemaVersion}\`). Newer values require an explicit migration.`,
		});
	}
	if ('prNumber' in frontmatter && !/^\d+$/.test(frontmatter.prNumber)) {
		errors.push({
			line: frontmatterEndLine,
			message: `Frontmatter \`prNumber\` must be a positive integer (got \`${frontmatter.prNumber}\`).`,
		});
	}
	for (const shaKey of ['baseSha', 'headSha']) {
		if (shaKey in frontmatter && !/^[0-9a-f]{7,64}$/i.test(frontmatter[shaKey])) {
			errors.push({
				line: frontmatterEndLine,
				message: `Frontmatter \`${shaKey}\` must be a hex git SHA (got \`${frontmatter[shaKey]}\`).`,
			});
		}
	}

	// ----- 2. Title -------------------------------------------------------
	let titleLine = -1;
	const titleSearchStart = Math.max(0, frontmatterEndLine);
	for (let i = titleSearchStart; i < lines.length; i++) {
		if (/^#\s+.+/.test(lines[i])) {
			titleLine = i + 1;
			break;
		}
		// Stop searching at first non-blank non-frontmatter line that isn't an H1.
		if (lines[i].trim().length > 0 && !lines[i].startsWith('#')) {
			break;
		}
	}
	if (titleLine === -1) {
		errors.push({
			line: titleSearchStart + 1,
			message: 'Document is missing an H1 title. Add a line like `# <Pull Request Title>` after the frontmatter.',
		});
	}

	// ----- 3. Hunks -------------------------------------------------------
	// New format: each hunk is a `<details>` block containing a `<summary>`,
	// a `<!-- changetour:hunk … -->` metadata comment, and a fenced ```diff
	// body. See `tryParseHunkBlock` / `buildHunkBlock` in
	// src/github/codeTourMarkdown.ts for the canonical shape.
	let i = 0;
	while (i < lines.length) {
		// Hard-cutover: explicitly flag any leftover legacy `:::hunk` directives.
		if (LEGACY_HUNK_OPEN_RE.test(lines[i])) {
			errors.push({
				line: i + 1,
				message: 'Legacy `:::hunk` directive found. The on-disk format moved to `<details>`-wrapped hunks; run `node scripts/migrate-change-tour.js <path>` to upgrade.',
			});
			i++;
			continue;
		}

		const openMatch = DETAILS_OPEN_RE.exec(lines[i]);
		if (!openMatch) {
			i++;
			continue;
		}

		const openLine = i + 1;
		let j = i + 1;
		const skipBlanks = () => { while (j < lines.length && lines[j].trim() === '') j++; };

		// Peek-ahead: not every <details> block is a hunk - authors might use
		// <details> for narration too. If the shape doesn't match, fall back to
		// treating this line as plain content (no error).
		skipBlanks();
		const summaryLineIdx = j;
		if (j >= lines.length || !SUMMARY_LINE_RE.test(lines[j])) {
			i++;
			continue;
		}
		j++;

		skipBlanks();
		if (j >= lines.length) {
			i++;
			continue;
		}
		const metaMatch = HUNK_METADATA_RE.exec(lines[j]);
		if (!metaMatch) {
			// <details>+<summary> with no metadata comment - probably narration.
			i++;
			continue;
		}
		const metaLineIdx = j;
		const metaLine = j + 1;
		const attrs = parseHunkAttributes(metaMatch[1]);
		j++;

		// Indentation check on the four structural HTML lines we just matched.
		// GitHub treats lines indented 4+ spaces as code blocks, so any leading
		// whitespace on these elements silently breaks the rendered <details>
		// surface even though the in-extension parser tolerates it. We require
		// column-zero placement to match the canonical shape and the LLM
		// instructions.
		const indentationErrors = [];
		if (HAS_LEADING_WHITESPACE_RE.test(lines[i])) {
			indentationErrors.push({ line: openLine, what: '`<details>`' });
		}
		if (HAS_LEADING_WHITESPACE_RE.test(lines[summaryLineIdx])) {
			indentationErrors.push({ line: summaryLineIdx + 1, what: '`<summary>`' });
		}
		if (HAS_LEADING_WHITESPACE_RE.test(lines[metaLineIdx])) {
			indentationErrors.push({ line: metaLineIdx + 1, what: '`<!-- changetour:hunk ... -->`' });
		}
		for (const e of indentationErrors) {
			errors.push({
				line: e.line,
				message: `${e.what} line has leading whitespace. Hunks must be at column zero - indented HTML becomes a literal code block on GitHub and breaks the rendered <details> surface.`,
			});
		}

		// From this point on we're committed to treating this as a hunk
		// block - structural issues below are real errors, not "this isn't
		// a hunk" fallthroughs.

		if (!attrs.file) {
			errors.push({ line: metaLine, message: 'Hunk metadata comment missing required `file=<path>` attribute.' });
		}
		if ('highlights' in attrs) {
			const segments = attrs.highlights.split(',');
			for (const seg of segments) {
				if (!/^(old|new):\d+(?:-\d+)?$/.test(seg.trim())) {
					errors.push({
						line: metaLine,
						message: `Hunk \`highlights\` segment \`${seg}\` is malformed. Expected \`new:14-18\` or \`old:22\`.`,
					});
				}
			}
		}
		if ('pinned' in attrs && attrs.pinned !== 'true') {
			errors.push({
				line: metaLine,
				message: `Hunk \`pinned\` must be \`true\` if present (got \`${attrs.pinned}\`). Omit the attribute to indicate "not pinned".`,
			});
		}

		skipBlanks();
		if (j >= lines.length || !DIFF_FENCE_OPEN_RE.test(lines[j])) {
			errors.push({
				line: openLine,
				message: 'Hunk block is missing the ```diff fence after the metadata comment. The patch body must be wrapped in ```diff … ```.',
			});
			i = j;
			continue;
		}
		const fenceOpenLineIdx = j;
		if (HAS_LEADING_WHITESPACE_RE.test(lines[fenceOpenLineIdx])) {
			errors.push({
				line: fenceOpenLineIdx + 1,
				message: '```diff fence line has leading whitespace. The fence must start at column zero.',
			});
		}
		j++;

		const firstBodyLine = j + 1;
		const patchBodyLines = [];
		while (j < lines.length && !DIFF_FENCE_CLOSE_RE.test(lines[j])) {
			patchBodyLines.push(lines[j]);
			j++;
		}
		if (j >= lines.length) {
			errors.push({ line: openLine, message: 'Hunk ```diff fence is not closed.' });
			i = j;
			continue;
		}
		j++; // consume closing ```

		if (patchBodyLines.length === 0) {
			errors.push({
				line: openLine,
				message: 'Hunk has no patch body inside the ```diff fence. The diff content (starting with the `@@` line) must appear between the opening and closing fence.',
			});
		} else if (!HUNK_HEADER_LINE_RE.test(patchBodyLines[0])) {
			warnings.push({
				line: firstBodyLine,
				message: 'Hunk body does not start with an `@@ -…,… +…,… @@` header. The editor expects the full raw patch including the hunk header.',
			});
		}

		skipBlanks();
		if (j >= lines.length || !DETAILS_CLOSE_RE.test(lines[j])) {
			errors.push({
				line: openLine,
				message: 'Hunk `<details>` block is not closed. Expected `</details>` after the ```diff fence.',
			});
			i = j;
			continue;
		}
		const closeLineIdx = j;
		if (HAS_LEADING_WHITESPACE_RE.test(lines[closeLineIdx])) {
			errors.push({
				line: closeLineIdx + 1,
				message: '`</details>` line has leading whitespace. It must start at column zero.',
			});
		}
		j++; // consume </details>

		// Derive line range from the @@ +C,D @@ header.
		let startLine, endLine;
		if (patchBodyLines.length > 0) {
			const rangeMatch = HUNK_BODY_RANGE_RE.exec(patchBodyLines[0]);
			if (rangeMatch) {
				const newStart = parseInt(rangeMatch[1], 10);
				const newCount = rangeMatch[2] !== undefined ? parseInt(rangeMatch[2], 10) : 1;
				startLine = newStart;
				endLine = newStart + Math.max(newCount, 1) - 1;
			}
		}

		if (attrs.file && startLine !== undefined && endLine !== undefined) {
			hunks.push({
				file: attrs.file,
				startLine,
				endLine,
				openLine,
				previousFile: attrs.previousFile,
			});
		}

		i = j;
	}

	if (hunks.length === 0) {
		warnings.push({
			line: 1,
			message: 'No hunks found. A Change Tour without any hunks is unusual - make sure the LLM did not skip inserting them.',
		});
	}

	return { errors, warnings, frontmatter, hunks };
}

/* ----- PR cross-check ------------------------------------------------ */

/**
 * Run `gh` and return stdout, or null if `gh` isn't available, isn't
 * authenticated, or the fetch fails for any reason. Never throws - the
 * caller treats null as "skip the cross-check".
 */
function tryRunGh(args) {
	try {
		const out = execFileSync('gh', args, {
			encoding: 'utf8',
			maxBuffer: 1024 * 1024 * 50, // 50 MB - big PRs can be huge
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return { ok: true, out };
	} catch (err) {
		const stderr = err.stderr ? String(err.stderr).trim() : '';
		const code = err.code;
		let reason;
		if (code === 'ENOENT') {
			reason = '`gh` CLI is not installed. PR cross-check skipped - install GitHub CLI (https://cli.github.com) to enable it.';
		} else if (stderr.includes('not logged') || stderr.includes('authentication')) {
			reason = '`gh` is not authenticated. PR cross-check skipped - run `gh auth login` to enable it.';
		} else {
			reason = `\`gh\` invocation failed: ${stderr || err.message}. PR cross-check skipped.`;
		}
		return { ok: false, reason };
	}
}

/**
 * Parse a unified diff and return a map from new-side file path to a list of
 * hunk ranges `{ startLine, endLine, previousFile? }`.
 *
 * Handles:
 *   - regular modifies/adds (uses `+++ b/path`)
 *   - deletes (uses `--- a/path`, `+++ /dev/null` - recorded but no new-side ranges)
 *   - renames (records previousFile via `rename from`/`rename to` headers)
 */
function parsePrDiff(diffText) {
	const files = new Map(); // newPath -> { previousFile?, hunks: [] }
	const lines = diffText.split('\n');

	let currentFile = null;
	let currentEntry = null;
	let pendingPreviousFile = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// New file section header
		const diffMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
		if (diffMatch) {
			currentFile = null;
			currentEntry = null;
			pendingPreviousFile = null;
			// rename from / rename to lines may appear in the next few lines
			continue;
		}

		const renameFrom = /^rename from (.+)$/.exec(line);
		if (renameFrom) {
			pendingPreviousFile = renameFrom[1];
			continue;
		}
		const renameTo = /^rename to (.+)$/.exec(line);
		if (renameTo) {
			currentFile = renameTo[1];
			currentEntry = files.get(currentFile);
			if (!currentEntry) {
				currentEntry = { previousFile: pendingPreviousFile || undefined, hunks: [] };
				files.set(currentFile, currentEntry);
			}
			continue;
		}

		const plusFileMatch = /^\+\+\+ (?:b\/(.+)|\/dev\/null)$/.exec(line);
		if (plusFileMatch) {
			if (plusFileMatch[1]) {
				currentFile = plusFileMatch[1];
				currentEntry = files.get(currentFile);
				if (!currentEntry) {
					currentEntry = { previousFile: pendingPreviousFile || undefined, hunks: [] };
					files.set(currentFile, currentEntry);
				}
			} else {
				// Deletion - no new-side path. Skip recording hunks.
				currentFile = null;
				currentEntry = null;
			}
			pendingPreviousFile = null;
			continue;
		}

		const hunkHeaderMatch = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line);
		if (hunkHeaderMatch && currentEntry) {
			const newStart = parseInt(hunkHeaderMatch[1], 10);
			const newLen = hunkHeaderMatch[2] !== undefined ? parseInt(hunkHeaderMatch[2], 10) : 1;
			const endLine = newStart + Math.max(newLen, 1) - 1;
			currentEntry.hunks.push({ startLine: newStart, endLine });
		}
	}

	return files;
}

/**
 * Verify each hunk in `tourHunks` corresponds to a real hunk in `prFiles`.
 * Returns a list of issue objects (errors).
 */
function crossCheckHunks(tourHunks, prFiles) {
	const issues = [];
	for (const h of tourHunks) {
		const entry = prFiles.get(h.file);
		if (!entry) {
			const availableSample = Array.from(prFiles.keys()).slice(0, 8).join(', ');
			issues.push({
				line: h.openLine,
				message: `Hunk file \`${h.file}\` is not changed by the bound pull request. Available files include: ${availableSample}${prFiles.size > 8 ? ', …' : ''}`,
			});
			continue;
		}
		if (entry.hunks.length === 0) {
			issues.push({
				line: h.openLine,
				message: `Hunk file \`${h.file}\` has no diff hunks in the bound pull request (it may be a deletion or binary file).`,
			});
			continue;
		}
		const matched = entry.hunks.some(rh => rh.startLine === h.startLine && rh.endLine === h.endLine);
		if (!matched) {
			const available = entry.hunks.map(rh => `${rh.startLine}-${rh.endLine}`).join(', ');
			issues.push({
				line: h.openLine,
				message: `Hunk \`${h.file}\` lines ${h.startLine}-${h.endLine} does not match any real hunk in the pull request. Available new-side ranges for this file: ${available}`,
			});
			continue;
		}
		// Optional: check that the rename direction matches
		if (h.previousFile && entry.previousFile && h.previousFile !== entry.previousFile) {
			issues.push({
				line: h.openLine,
				message: `Hunk \`previousFile=${h.previousFile}\` does not match the pull request's recorded previous file (${entry.previousFile}).`,
			});
		}
	}
	return issues;
}

/**
 * Find hunks present in the PR diff but not in the tour. Returns a list of
 * `{ file, startLine, endLine }` entries describing the missing hunks.
 * Used by the coverage check (`/generate` requires that every PR hunk is
 * represented in the tour - trivial ones grouped into a Miscellaneous section).
 */
function findUncoveredHunks(tourHunks, prFiles) {
	const covered = new Set();
	for (const h of tourHunks) {
		covered.add(`${h.file}:${h.startLine}:${h.endLine}`);
	}
	const missing = [];
	for (const [file, entry] of prFiles.entries()) {
		for (const rh of entry.hunks) {
			const key = `${file}:${rh.startLine}:${rh.endLine}`;
			if (!covered.has(key)) {
				missing.push({ file, startLine: rh.startLine, endLine: rh.endLine });
			}
		}
	}
	return missing;
}

/* ----- CLI entry ----------------------------------------------------- */

function parseArgs(argv) {
	const args = {
		filePath: undefined,
		skipPrCheck: false,
		pr: undefined,
		repo: undefined,
		requireFullCoverage: false,
	};
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--skip-pr-check') {
			args.skipPrCheck = true;
		} else if (a === '--pr') {
			args.pr = argv[++i];
		} else if (a === '--repo') {
			args.repo = argv[++i];
		} else if (a === '--require-full-coverage') {
			args.requireFullCoverage = true;
		} else if (a === '--help' || a === '-h') {
			args.help = true;
		} else if (!args.filePath) {
			args.filePath = a;
		} else {
			console.error(`Unknown argument: ${a}`);
			args.help = true;
		}
	}
	return args;
}

function formatIssue(filePath, issue, level) {
	const prefix = level === 'error' ? 'error' : 'warning';
	return `${filePath}:${issue.line}: ${prefix}: ${issue.message}`;
}

function printHelp() {
	console.error('Usage: node validate-change-tour.js <path-to-tour.changetour.md> [options]');
	console.error('');
	console.error('Options:');
	console.error('  --skip-pr-check          Skip the optional cross-check against the live PR diff via `gh`.');
	console.error('  --pr <number>            Override the prNumber from frontmatter for the cross-check.');
	console.error('  --repo <owner>/<repo>    Override the prOwner/prRepo from frontmatter for the cross-check.');
	console.error('  --require-full-coverage  Upgrade "PR hunk not covered" warnings to errors. Useful for CI');
	console.error('                           or strict /generate workflows where every hunk must appear in the tour.');
	console.error('  -h, --help               Show this help.');
}

function main(argv) {
	const args = parseArgs(argv);
	if (args.help || !args.filePath) {
		printHelp();
		process.exit(args.help ? 0 : 2);
	}
	const filePath = path.resolve(args.filePath);
	if (!fs.existsSync(filePath)) {
		console.error(`File not found: ${filePath}`);
		process.exit(2);
	}
	const text = fs.readFileSync(filePath, 'utf8');
	const structResult = validateStructure(text);

	const allErrors = [...structResult.errors];
	const allWarnings = [...structResult.warnings];

	// ----- PR cross-check phase ------------------------------------------
	const hasPRInfo = (
		(args.pr || /^\d+$/.test(structResult.frontmatter.prNumber || ''))
		&& (args.repo || (structResult.frontmatter.prOwner && structResult.frontmatter.prRepo))
	);
	if (!args.skipPrCheck && hasPRInfo && structResult.hunks.length > 0) {
		const prNumber = args.pr || structResult.frontmatter.prNumber;
		const repo = args.repo || `${structResult.frontmatter.prOwner}/${structResult.frontmatter.prRepo}`;
		const ghResult = tryRunGh(['pr', 'diff', String(prNumber), '-R', repo]);
		if (!ghResult.ok) {
			allWarnings.push({ line: 1, message: ghResult.reason });
		} else {
			try {
				const prFiles = parsePrDiff(ghResult.out);
				const crossIssues = crossCheckHunks(structResult.hunks, prFiles);
				allErrors.push(...crossIssues);

				// Coverage check (PR → tour direction). `/generate` requires every PR
				// hunk to appear in the tour, with trivial ones grouped under a
				// Miscellaneous section. By default we report uncovered hunks as
				// warnings; --require-full-coverage promotes them to errors so CI
				// or strict workflows can hard-fail incomplete tours.
				const uncovered = findUncoveredHunks(structResult.hunks, prFiles);
				if (uncovered.length > 0) {
					const sink = args.requireFullCoverage ? allErrors : allWarnings;
					const preview = uncovered
						.slice(0, 10)
						.map(h => `${h.file}:${h.startLine}-${h.endLine}`)
						.join(', ');
					const more = uncovered.length > 10 ? `, …(+${uncovered.length - 10} more)` : '';
					sink.push({
						line: 1,
						message: `${uncovered.length} PR hunk(s) are not covered by this tour: ${preview}${more}. Add them (use a "Miscellaneous" section for trivial ones) or pass --skip-pr-check to ignore.`,
					});
				}
			} catch (err) {
				allWarnings.push({
					line: 1,
					message: `Could not parse \`gh pr diff\` output: ${err.message}. PR cross-check skipped.`,
				});
			}
		}
	} else if (args.skipPrCheck) {
		// Quiet - user explicitly opted out
	} else if (!hasPRInfo && structResult.hunks.length > 0) {
		allWarnings.push({
			line: 1,
			message: 'Skipped PR cross-check because frontmatter is incomplete. Add prNumber/prOwner/prRepo or pass --pr/--repo.',
		});
	}

	for (const w of allWarnings) {
		console.error(formatIssue(filePath, w, 'warning'));
	}
	for (const e of allErrors) {
		console.error(formatIssue(filePath, e, 'error'));
	}

	if (allErrors.length > 0) {
		console.error(`\n${allErrors.length} error(s), ${allWarnings.length} warning(s) - tour is invalid.`);
		process.exit(1);
	}
	console.log(`OK - tour is valid (${allWarnings.length} warning(s)).`);
	process.exit(0);
}

if (require.main === module) {
	main(process.argv);
}

module.exports = { validateStructure, parsePrDiff, crossCheckHunks, findUncoveredHunks };
