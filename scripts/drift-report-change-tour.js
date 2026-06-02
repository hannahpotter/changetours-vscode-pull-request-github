/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Standalone drift / coverage report for `.changetour.md` files.
 *
 * Usage:
 *   node drift-report-change-tour.js <path-to-tour.changetour.md> [--pr <number>] [--repo <owner>/<repo>]
 *
 * Computes EXACTLY the same three lists as the in-extension
 * `changeTour_getDriftReport` tool (src/lm/tourAssistant/tools.ts):
 *
 *   - drifted:        tour hunks whose patch content no longer matches any
 *                     current PR hunk for the same file. These need to be
 *                     replaced with the current PR version.
 *   - missingInTour:  PR hunks no tour hunk covers by content. These need
 *                     to be added to the tour.
 *   - removedFromPR:  tour hunks whose file is no longer in the PR diff.
 *                     These need to be removed from the tour.
 *
 * Pinned hunks (`pinned="true"` in the metadata comment) are intentional
 * historical context and are never reported - mirroring the in-extension
 * detector's behavior.
 *
 * Bundled alongside the Claude Code change-tour skill (installed to
 * `<repoRoot>/.claude/skills/change-tour/drift-report-change-tour.js`) so
 * the external Claude CLI has the same ground-truth signal the
 * in-extension assistant gets from its tool registry. SKILL.md tells Claude
 * to run this script as the first step of the update workflow and to keep
 * iterating until all three lists are empty.
 *
 * Default output is human-readable; pass `--json` for machine-parsable JSON
 * (the format the in-extension tool returns). Exit code is 0 when all three
 * lists are empty, 1 otherwise.
 *
 * Dependency-free so it runs anywhere Node does.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DETAILS_OPEN_RE = /^\s*<details(\s+open)?\s*>\s*$/;
const DETAILS_CLOSE_RE = /^\s*<\/details>\s*$/;
const SUMMARY_LINE_RE = /^\s*<summary>.*<\/summary>\s*$/;
const HUNK_METADATA_RE = /^\s*<!--\s*changetour:hunk\s+(.*?)\s*-->\s*$/;
const DIFF_FENCE_OPEN_RE = /^\s*```diff\s*$/;
const DIFF_FENCE_CLOSE_RE = /^\s*```\s*$/;
const PATCH_HEADER_RE = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/;

/* ----- Tour parsing -------------------------------------------------- */

/**
 * Same `key=value` / `key="quoted"` grammar the in-extension parser uses
 * for the `<!-- changetour:hunk … -->` metadata comment.
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

function parseTourHunks(text) {
	const lines = text.split('\n');
	const out = [];

	// Skip the frontmatter (`---` … `---`) and the H1.
	let i = 0;
	if (lines[0] && lines[0].trim() === '---') {
		i = 1;
		while (i < lines.length && lines[i].trim() !== '---') i++;
		if (i < lines.length) i++; // closing ---
	}

	while (i < lines.length) {
		if (!DETAILS_OPEN_RE.test(lines[i])) { i++; continue; }
		let j = i + 1;
		const skipBlanks = () => { while (j < lines.length && lines[j].trim() === '') j++; };

		skipBlanks();
		if (j >= lines.length || !SUMMARY_LINE_RE.test(lines[j])) { i++; continue; }
		j++;

		skipBlanks();
		const metaMatch = j < lines.length ? HUNK_METADATA_RE.exec(lines[j]) : null;
		if (!metaMatch) { i++; continue; }
		const attrs = parseHunkAttributes(metaMatch[1]);
		j++;

		skipBlanks();
		if (j >= lines.length || !DIFF_FENCE_OPEN_RE.test(lines[j])) { i++; continue; }
		j++;

		const patchLines = [];
		while (j < lines.length && !DIFF_FENCE_CLOSE_RE.test(lines[j])) {
			patchLines.push(lines[j]);
			j++;
		}
		if (j >= lines.length) { i++; continue; } // unclosed
		j++; // closing ```
		skipBlanks();
		if (j < lines.length && DETAILS_CLOSE_RE.test(lines[j])) j++;

		// Derive line range from the @@ header.
		let startLine, endLine;
		if (patchLines.length > 0) {
			const m = PATCH_HEADER_RE.exec(patchLines[0]);
			if (m) {
				const newStart = parseInt(m[1], 10);
				const newCount = m[2] !== undefined ? parseInt(m[2], 10) : 1;
				startLine = newStart;
				endLine = newStart + Math.max(newCount, 1) - 1;
			}
		}

		if (attrs.file && startLine !== undefined && endLine !== undefined) {
			out.push({
				// Tour hunks do not have stable node IDs across CLI runs (the
				// in-extension `id` is parser-generated); use a deterministic
				// "tourNodeId" that the human can paste back as a reference.
				tourNodeId: `${attrs.file}:${startLine}-${endLine}`,
				file: attrs.file,
				previousFile: attrs.previousFile,
				startLine,
				endLine,
				pinned: attrs.pinned === 'true',
				patch: patchLines.join('\n'),
			});
		}

		i = j;
	}

	return out;
}

/* ----- Fingerprint --------------------------------------------------- */

/**
 * Same edit-content fingerprint the in-extension detector uses. Two patches
 * with identical `+`/`-` lines describe the same edit even if their `@@`
 * headers and context lines differ. CRLF-normalized.
 */
function editContentFingerprint(patch) {
	if (!patch) return undefined;
	const out = [];
	for (const raw of patch.split('\n')) {
		const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
		if (line.length === 0 || line.startsWith('@@')) continue;
		const marker = line[0];
		if (marker === '+' || marker === '-') out.push(line);
	}
	return out.join('\n');
}

/* ----- PR diff fetch + parse ----------------------------------------- */

function tryRunGh(args) {
	try {
		const out = execFileSync('gh', args, {
			encoding: 'utf8',
			maxBuffer: 1024 * 1024 * 50,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return { ok: true, out };
	} catch (err) {
		const code = err.code;
		const stderr = err.stderr ? String(err.stderr).trim() : '';
		if (code === 'ENOENT') return { ok: false, reason: 'gh CLI is not installed.' };
		if (stderr.includes('not logged') || stderr.includes('authentication')) {
			return { ok: false, reason: 'gh is not authenticated. Run `gh auth login`.' };
		}
		return { ok: false, reason: `gh failed: ${stderr || err.message}` };
	}
}

/**
 * Parse a unified diff into per-file hunk lists with full patch text per
 * hunk. The patch text per hunk is what we fingerprint against the tour's
 * stored patches.
 */
function parsePrDiff(diffText) {
	const files = new Map(); // newPath → { previousFile?, hunks: [{ startLine, endLine, patch }] }
	const lines = diffText.split('\n');

	let currentFile = null;
	let currentEntry = null;
	let pendingPreviousFile = null;
	let currentHunk = null;
	let currentHunkBuf = [];

	const closeHunk = () => {
		if (currentHunk && currentEntry) {
			currentEntry.hunks.push({
				startLine: currentHunk.startLine,
				endLine: currentHunk.endLine,
				patch: currentHunkBuf.join('\n'),
			});
		}
		currentHunk = null;
		currentHunkBuf = [];
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (/^diff --git a\/(.+?) b\/(.+)$/.test(line)) {
			closeHunk();
			currentFile = null;
			currentEntry = null;
			pendingPreviousFile = null;
			continue;
		}
		const renameFrom = /^rename from (.+)$/.exec(line);
		if (renameFrom) { pendingPreviousFile = renameFrom[1]; continue; }
		const renameTo = /^rename to (.+)$/.exec(line);
		if (renameTo) {
			closeHunk();
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
			closeHunk();
			if (plusFileMatch[1]) {
				currentFile = plusFileMatch[1];
				currentEntry = files.get(currentFile);
				if (!currentEntry) {
					currentEntry = { previousFile: pendingPreviousFile || undefined, hunks: [] };
					files.set(currentFile, currentEntry);
				}
			} else {
				currentFile = null;
				currentEntry = null;
			}
			pendingPreviousFile = null;
			continue;
		}
		const headerMatch = PATCH_HEADER_RE.exec(line);
		if (headerMatch && currentEntry) {
			closeHunk();
			const newStart = parseInt(headerMatch[1], 10);
			const newCount = headerMatch[2] !== undefined ? parseInt(headerMatch[2], 10) : 1;
			currentHunk = { startLine: newStart, endLine: newStart + Math.max(newCount, 1) - 1 };
			currentHunkBuf = [line];
			continue;
		}
		if (currentHunk) {
			currentHunkBuf.push(line);
		}
	}
	closeHunk();

	return files;
}

/* ----- Drift report -------------------------------------------------- */

function computeDriftReport(tourHunks, prFiles) {
	const prFingerprintsByFile = new Map();
	const renamedFrom = new Map();
	for (const [file, entry] of prFiles) {
		const fps = new Set();
		for (const h of entry.hunks) {
			const fp = editContentFingerprint(h.patch);
			if (fp) fps.add(fp);
		}
		prFingerprintsByFile.set(file, fps);
		if (entry.previousFile && entry.previousFile !== file) {
			renamedFrom.set(entry.previousFile, file);
		}
	}

	const resolvePrFile = (tourFile, prev) => {
		if (prFingerprintsByFile.has(tourFile)) return tourFile;
		const renamed = renamedFrom.get(tourFile);
		if (renamed && prFingerprintsByFile.has(renamed)) return renamed;
		if (prev && prFingerprintsByFile.has(prev)) return prev;
		return undefined;
	};

	const drifted = [];
	const removedFromPR = [];
	const coveredFps = new Map();
	const addCovered = (file, fp) => {
		let s = coveredFps.get(file);
		if (!s) { s = new Set(); coveredFps.set(file, s); }
		s.add(fp);
	};

	for (const t of tourHunks) {
		const fingerprintFile = resolvePrFile(t.file, t.previousFile);
		const prFps = fingerprintFile ? prFingerprintsByFile.get(fingerprintFile) : undefined;
		const hunkFp = editContentFingerprint(t.patch);
		if (!fingerprintFile || !prFps) {
			removedFromPR.push({ tourNodeId: t.tourNodeId, file: t.file, oldLines: `${t.startLine}-${t.endLine}` });
		} else if (t.pinned) {
			if (hunkFp) addCovered(fingerprintFile, hunkFp);
		} else if (!hunkFp || !prFps.has(hunkFp)) {
			drifted.push({
				tourNodeId: t.tourNodeId,
				file: t.file,
				oldLines: `${t.startLine}-${t.endLine}`,
				reason: !hunkFp ? 'tour hunk has no patch content; cannot compare' : 'patch content does not match any current PR hunk for this file',
			});
		} else {
			addCovered(fingerprintFile, hunkFp);
		}
	}

	const missingInTour = [];
	for (const [file, entry] of prFiles) {
		const covered = coveredFps.get(file);
		for (const h of entry.hunks) {
			const fp = editContentFingerprint(h.patch);
			if (fp && covered && covered.has(fp)) continue;
			missingInTour.push({ file, startLine: h.startLine, endLine: h.endLine });
		}
	}

	return { drifted, missingInTour, removedFromPR };
}

/* ----- CLI ----------------------------------------------------------- */

function readFrontmatter(text) {
	const out = {};
	const lines = text.split('\n');
	if (!lines[0] || lines[0].trim() !== '---') return out;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === '---') break;
		const m = /^([a-zA-Z0-9_]+)\s*:\s*(.+)$/.exec(lines[i]);
		if (m) out[m[1]] = m[2].trim();
	}
	return out;
}

function parseArgs(argv) {
	const args = { filePath: undefined, pr: undefined, repo: undefined, json: false, help: false };
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--pr') args.pr = argv[++i];
		else if (a === '--repo') args.repo = argv[++i];
		else if (a === '--json') args.json = true;
		else if (a === '-h' || a === '--help') args.help = true;
		else if (!args.filePath) args.filePath = a;
		else { console.error(`Unknown argument: ${a}`); args.help = true; }
	}
	return args;
}

function printHelp() {
	console.error('Usage: node drift-report-change-tour.js <path-to-tour.changetour.md> [options]');
	console.error('');
	console.error('Options:');
	console.error('  --pr <number>          Override the prNumber from frontmatter.');
	console.error('  --repo <owner>/<repo>  Override the prOwner/prRepo from frontmatter.');
	console.error('  --json                 Emit JSON only (machine-parsable).');
	console.error('  -h, --help             Show this help.');
	console.error('');
	console.error('Exit code 0 = no drift detected; 1 = at least one of drifted/missingInTour/removedFromPR is non-empty.');
}

function main(argv) {
	const args = parseArgs(argv);
	if (args.help || !args.filePath) { printHelp(); process.exit(args.help ? 0 : 2); }

	const filePath = path.resolve(args.filePath);
	if (!fs.existsSync(filePath)) { console.error(`File not found: ${filePath}`); process.exit(2); }
	const text = fs.readFileSync(filePath, 'utf8');

	const fm = readFrontmatter(text);
	const prNumber = args.pr || fm.prNumber;
	const repo = args.repo || (fm.prOwner && fm.prRepo ? `${fm.prOwner}/${fm.prRepo}` : undefined);
	if (!prNumber || !repo) {
		console.error('Could not determine PR number/repo. Pass --pr and --repo, or ensure the tour has prNumber/prOwner/prRepo in frontmatter.');
		process.exit(2);
	}

	const ghResult = tryRunGh(['pr', 'diff', String(prNumber), '-R', repo]);
	if (!ghResult.ok) { console.error(ghResult.reason); process.exit(2); }

	const tourHunks = parseTourHunks(text);
	const prFiles = parsePrDiff(ghResult.out);
	const report = computeDriftReport(tourHunks, prFiles);

	if (args.json) {
		process.stdout.write(JSON.stringify(report, null, 2) + '\n');
	} else {
		const { drifted, missingInTour, removedFromPR } = report;
		console.log(`Drift report for ${path.basename(filePath)} (PR ${repo}#${prNumber})`);
		console.log('');
		console.log(`drifted (${drifted.length}) - tour hunks whose patch content no longer matches the PR:`);
		drifted.forEach(d => console.log(`  - ${d.tourNodeId}  (${d.reason})`));
		console.log('');
		console.log(`missingInTour (${missingInTour.length}) - PR hunks no tour hunk covers:`);
		missingInTour.forEach(m => console.log(`  - ${m.file}:${m.startLine}-${m.endLine}`));
		console.log('');
		console.log(`removedFromPR (${removedFromPR.length}) - tour hunks whose file is no longer in the PR diff:`);
		removedFromPR.forEach(r => console.log(`  - ${r.tourNodeId}`));
		console.log('');
		const total = drifted.length + missingInTour.length + removedFromPR.length;
		if (total === 0) {
			console.log('OK - the tour is in sync with the PR.');
		} else {
			console.log(`${total} item(s) need attention.`);
		}
	}

	const empty = report.drifted.length === 0 && report.missingInTour.length === 0 && report.removedFromPR.length === 0;
	process.exit(empty ? 0 : 1);
}

if (require.main === module) {
	main(process.argv);
}

module.exports = { parseTourHunks, parsePrDiff, computeDriftReport, editContentFingerprint };
