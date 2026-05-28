/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Standalone validator for .codetour.md files.
 *
 * Usage:
 *   node validate-change-tour.js <path-to-tour.codetour.md> [--skip-pr-check]
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

const REQUIRED_FRONTMATTER_KEYS = ['isPR', 'prNumber', 'prOwner', 'prRepo'];
const RECOMMENDED_FRONTMATTER_KEYS = ['baseRef'];

const HUNK_OPEN_RE = /^:::hunk\s+(.*)$/;
const HUNK_CLOSE_RE = /^:::$/;
const HUNK_HEADER_LINE_RE = /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/;

/* ----- Structural validation ----------------------------------------- */

/**
 * Parse the `key=value` portion of a `:::hunk` directive. Returns a
 * { key: value } object. Unknown keys are kept verbatim so consumers
 * can warn about them.
 */
function parseHunkAttributes(rest) {
	const attrs = {};
	const re = /(\w+)=([^\s]+)/g;
	let m;
	while ((m = re.exec(rest)) !== null) {
		attrs[m[1]] = m[2];
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
			message: 'Missing frontmatter. The first line must be `---` followed by `isPR`, `prNumber`, `prOwner`, `prRepo` (and ideally `baseRef`), closed by another `---`.',
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

	if ('isPR' in frontmatter && frontmatter.isPR !== 'true') {
		errors.push({
			line: frontmatterEndLine,
			message: `Frontmatter \`isPR\` must be \`true\` (got \`${frontmatter.isPR}\`).`,
		});
	}
	if ('prNumber' in frontmatter && !/^\d+$/.test(frontmatter.prNumber)) {
		errors.push({
			line: frontmatterEndLine,
			message: `Frontmatter \`prNumber\` must be a positive integer (got \`${frontmatter.prNumber}\`).`,
		});
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
	let i = 0;
	while (i < lines.length) {
		const open = HUNK_OPEN_RE.exec(lines[i]);
		if (!open) {
			// Stray closing `:::` line outside a hunk?
			if (HUNK_CLOSE_RE.test(lines[i])) {
				errors.push({
					line: i + 1,
					message: 'Unexpected `:::` - there is no open `:::hunk` block to close.',
				});
			}
			i++;
			continue;
		}

		const openLine = i + 1;
		const attrs = parseHunkAttributes(open[1]);

		// Required attributes
		let startLine, endLine;
		if (!attrs.file) {
			errors.push({ line: openLine, message: 'Hunk directive missing required `file=<path>` attribute.' });
		}
		if (!attrs.lines) {
			errors.push({ line: openLine, message: 'Hunk directive missing required `lines=<start>-<end>` attribute.' });
		} else if (!/^\d+-\d+$/.test(attrs.lines)) {
			errors.push({ line: openLine, message: `Hunk \`lines\` attribute must be \`<start>-<end>\` (got \`${attrs.lines}\`).` });
		} else {
			[startLine, endLine] = attrs.lines.split('-').map(Number);
			if (startLine > endLine) {
				errors.push({ line: openLine, message: `Hunk \`lines=${attrs.lines}\` has start > end.` });
			}
			if (startLine < 1) {
				errors.push({ line: openLine, message: `Hunk \`lines=${attrs.lines}\` has start < 1 (lines are 1-indexed).` });
			}
		}
		if (!attrs.ref) {
			errors.push({ line: openLine, message: 'Hunk directive missing required `ref=<commit-ish>` attribute (use `ref=HEAD` for the PR head).' });
		}

		// Optional but checked-if-present attributes
		if ('highlights' in attrs) {
			const segments = attrs.highlights.split(',');
			for (const seg of segments) {
				if (!/^(old|new):\d+(?:-\d+)?$/.test(seg.trim())) {
					errors.push({
						line: openLine,
						message: `Hunk \`highlights\` segment \`${seg}\` is malformed. Expected \`new:14-18\` or \`old:22\`.`,
					});
				}
			}
		}

		// Body: must be present, must start with @@ header, must close with :::
		let j = i + 1;
		let bodyStarted = false;
		let firstBodyLine = -1;
		let closed = false;
		while (j < lines.length) {
			if (HUNK_CLOSE_RE.test(lines[j])) {
				closed = true;
				break;
			}
			if (!bodyStarted && lines[j].trim().length > 0) {
				bodyStarted = true;
				firstBodyLine = j + 1;
			}
			j++;
		}
		if (!closed) {
			errors.push({ line: openLine, message: 'Hunk block is not closed - missing `:::` on its own line after the patch body.' });
		}
		if (!bodyStarted) {
			errors.push({
				line: openLine,
				message: 'Hunk has no patch body. The diff content (starting with the `@@` line) must appear between the opening `:::hunk …` directive and the closing `:::`.',
			});
		} else if (firstBodyLine > 0 && !HUNK_HEADER_LINE_RE.test(lines[firstBodyLine - 1])) {
			warnings.push({
				line: firstBodyLine,
				message: 'Hunk body does not start with an `@@ -…,… +…,… @@` header. The editor expects the full raw patch including the hunk header.',
			});
		}

		// Record this hunk for the PR cross-check phase.
		if (attrs.file && startLine !== undefined && endLine !== undefined) {
			hunks.push({
				file: attrs.file,
				startLine,
				endLine,
				openLine,
				previousFile: attrs.previousFile,
			});
		}

		i = closed ? j + 1 : j;
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

/* ----- CLI entry ----------------------------------------------------- */

function parseArgs(argv) {
	const args = { filePath: undefined, skipPrCheck: false, pr: undefined, repo: undefined };
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--skip-pr-check') {
			args.skipPrCheck = true;
		} else if (a === '--pr') {
			args.pr = argv[++i];
		} else if (a === '--repo') {
			args.repo = argv[++i];
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
	console.error('Usage: node validate-change-tour.js <path-to-tour.codetour.md> [options]');
	console.error('');
	console.error('Options:');
	console.error('  --skip-pr-check       Skip the optional cross-check against the live PR diff via `gh`.');
	console.error('  --pr <number>         Override the prNumber from frontmatter for the cross-check.');
	console.error('  --repo <owner>/<repo> Override the prOwner/prRepo from frontmatter for the cross-check.');
	console.error('  -h, --help            Show this help.');
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

module.exports = { validateStructure, parsePrDiff, crossCheckHunks };
