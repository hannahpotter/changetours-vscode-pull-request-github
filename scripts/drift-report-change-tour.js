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
 * PR hunks are fetched from `gh api /repos/<repo>/pulls/<n>/files` (the same
 * REST `patch` field the extension builds `change.diffHunks` from) rather
 * than `gh pr diff`. The two sources disagree on hunk grouping - GitHub's
 * API merges adjacent change-blocks separated by a one-line context gap
 * that `git diff -U3` / `gh pr diff` keep split - so matching the extension
 * exactly requires reading from the API field.
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
const EXCLUDE_MARKER_RE = /<!--\s*changetour:exclude\s+(.*?)\s*-->/g;
const EXCLUDE_LINES_RE = /^(\d+)-(\d+)$/;
const DIFF_FENCE_OPEN_RE = /^\s*(`{3,})diff\s*$/;
const DIFF_FENCE_CLOSE_RE = /^\s*`{3,}\s*$/;
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
		const openMatch = j < lines.length ? DIFF_FENCE_OPEN_RE.exec(lines[j]) : null;
		if (!openMatch) { i++; continue; }
		// Close fence must be >= opening length (CommonMark). Match exactly.
		const closePattern = new RegExp(`^\\s*\`{${openMatch[1].length},}\\s*$`);
		j++;

		const patchLines = [];
		while (j < lines.length && !closePattern.test(lines[j])) {
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

// FNV-1a-64 over UTF-8 bytes. Mirrors `fnv1a64HexOfUtf8` in
// src/github/codeTourMarkdown.ts so this CLI produces identical fingerprints
// to the extension and to any third-party tool following the spec in
// documentation/CHANGETOURSCHEMA.md.
const FNV_PRIME_64 = BigInt('0x100000001b3');
const FNV_OFFSET_64 = BigInt('0xcbf29ce484222325');
const MASK_64 = (BigInt(1) << BigInt(64)) - BigInt(1);
const TEXT_ENCODER = new TextEncoder();
function fnv1a64HexOfUtf8(input) {
	const bytes = TEXT_ENCODER.encode(input);
	let hash = FNV_OFFSET_64;
	for (let i = 0; i < bytes.length; i++) {
		hash = (hash ^ BigInt(bytes[i])) & MASK_64;
		hash = (hash * FNV_PRIME_64) & MASK_64;
	}
	return hash.toString(16).padStart(16, '0');
}

/**
 * Same edit-content fingerprint the in-extension detector uses: 16-hex-char
 * FNV-1a-64 hash over the UTF-8 encoding of the `+`/`-` lines (with `@@` and
 * context lines stripped, CRLF normalized). Two patches with identical edit
 * content fingerprint identically. See documentation/CHANGETOURSCHEMA.md.
 */
function editContentFingerprint(patch) {
	if (!patch) return undefined;
	const lines = [];
	for (const raw of patch.split('\n')) {
		const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
		if (line.length === 0 || line.startsWith('@@')) continue;
		const marker = line[0];
		if (marker === '+' || marker === '-') lines.push(line);
	}
	if (lines.length === 0) return undefined;
	return fnv1a64HexOfUtf8(lines.join('\n'));
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
 * Parse the GitHub REST `/pulls/<n>/files` response into the same per-file
 * hunk map shape `parsePrDiff` returns. Used in place of `gh pr diff` so the
 * CLI sees the *same* @@-hunk grouping the in-extension detector sees: the
 * REST `patch` field is what `change.diffHunks` is built from, and it merges
 * adjacent change-blocks across a one-line context gap that `gh pr diff` /
 * `git diff -U3` keep split. Sourcing from the same field is the only way
 * the two reports agree on hunk boundaries.
 */
function parseApiFiles(filesArray) {
	const files = new Map(); // newPath → { previousFile?, hunks: [{ startLine, endLine, patch }] }
	for (const f of filesArray) {
		const entry = {
			previousFile: f.previous_filename || undefined,
			hunks: [],
		};
		files.set(f.filename, entry);
		if (!f.patch) continue; // binary, too-large, or pure rename with no content change
		const lines = f.patch.split('\n');
		let currentHunk = null;
		let buf = [];
		const closeHunk = () => {
			if (currentHunk) {
				entry.hunks.push({
					startLine: currentHunk.startLine,
					endLine: currentHunk.endLine,
					patch: buf.join('\n'),
				});
			}
			currentHunk = null;
			buf = [];
		};
		for (const line of lines) {
			const m = PATCH_HEADER_RE.exec(line);
			if (m) {
				closeHunk();
				const newStart = parseInt(m[1], 10);
				const newCount = m[2] !== undefined ? parseInt(m[2], 10) : 1;
				currentHunk = { startLine: newStart, endLine: newStart + Math.max(newCount, 1) - 1 };
				buf = [line];
				continue;
			}
			if (currentHunk) buf.push(line);
		}
		closeHunk();
	}
	return files;
}

/**
 * `gh api --paginate` for an array response joins consecutive pages into a
 * single JSON array. Older gh versions emit one array per page concatenated
 * (`][`); we accept either form by collapsing `][` to `,`.
 */
function parsePaginatedJsonArray(out) {
	const trimmed = out.trim();
	if (!trimmed) return [];
	return JSON.parse(trimmed.replace(/\]\s*\[/g, ','));
}

/**
 * Parse a unified diff into per-file hunk lists with full patch text per
 * hunk. Kept for backward compatibility (other tools import this); the CLI
 * itself uses `parseApiFiles` so its hunk grouping matches the extension.
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

/**
 * Scan the raw tour markdown for `<!-- changetour:exclude file="..." lines="A-B"
 * fp="..." reason="..." -->` markers. Authors place these to opt PR hunks out
 * of the coverage report - a curation tool for hunks the author deliberately
 * left out of the tour. Mirrors `parseTourExclusions` in
 * src/github/codeTourMarkdown.ts.
 */
function parseTourExclusions(text) {
	const out = [];
	EXCLUDE_MARKER_RE.lastIndex = 0;
	let m;
	while ((m = EXCLUDE_MARKER_RE.exec(text)) !== null) {
		const attrs = {};
		const attrRe = /(\w+)=(?:"((?:\\.|[^"\\])*)"|([^\s]+))/g;
		let am;
		while ((am = attrRe.exec(m[1])) !== null) {
			attrs[am[1]] = am[2] !== undefined ? am[2].replace(/\\(["\\])/g, '$1') : am[3];
		}
		if (!attrs.file) continue;
		let startLine;
		let endLine;
		if (attrs.lines !== undefined) {
			const range = EXCLUDE_LINES_RE.exec(attrs.lines);
			if (!range) continue; // present but malformed -> skip
			startLine = parseInt(range[1], 10);
			endLine = parseInt(range[2], 10);
		}
		out.push({
			file: attrs.file,
			startLine,
			endLine,
			fp: attrs.fp,
			reason: attrs.reason,
		});
	}
	return out;
}

function isGlob(s) { return /[*?[]/.test(s); }

/**
 * `*` matches one path segment (no `/`); `**` matches across segments. No
 * braces, no character classes. Mirrors `matchesGlob` in
 * src/github/codeTourMarkdown.ts so the CLI matches the extension's
 * exclusion semantics byte-for-byte.
 */
function matchesGlob(pattern, path) {
	let re = '^';
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i];
		if (ch === '*' && pattern[i + 1] === '*') { re += '.*'; i += 2; }
		else if (ch === '*') { re += '[^/]*'; i += 1; }
		else if (ch === '?') { re += '[^/]'; i += 1; }
		else { re += ch.replace(/[.+^${}()|\\]/g, '\\$&'); i += 1; }
	}
	re += '$';
	return new RegExp(re).test(path);
}

function isExcluded(exclusions, file, startLine, endLine, hunkFp) {
	for (const e of exclusions) {
		const fileMatch = isGlob(e.file) ? matchesGlob(e.file, file) : e.file === file;
		if (!fileMatch) continue;
		const wholeFile = e.startLine === undefined && e.endLine === undefined;
		if (wholeFile) return true;
		// Prefer fingerprint match when both sides have one - lets the marker
		// survive PR rebases that shift line numbers. Fall back to line equality.
		if (e.fp && hunkFp) {
			if (e.fp === hunkFp) return true;
			continue;
		}
		if (e.startLine === startLine && e.endLine === endLine) return true;
	}
	return false;
}

function computeDriftReport(tourHunks, prFiles, exclusions = []) {
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
			if (isExcluded(exclusions, file, h.startLine, h.endLine, fp)) continue;
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

	const ghResult = tryRunGh(['api', '--paginate', `/repos/${repo}/pulls/${prNumber}/files`]);
	if (!ghResult.ok) { console.error(ghResult.reason); process.exit(2); }

	let apiFiles;
	try {
		apiFiles = parsePaginatedJsonArray(ghResult.out);
	} catch (err) {
		console.error(`Could not parse \`gh api\` response: ${err.message}`);
		process.exit(2);
	}

	const tourHunks = parseTourHunks(text);
	const exclusions = parseTourExclusions(text);
	const prFiles = parseApiFiles(apiFiles);
	const report = computeDriftReport(tourHunks, prFiles, exclusions);

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
		if (exclusions.length > 0) {
			console.log('');
			console.log(`(${exclusions.length} PR hunk(s) intentionally excluded via \`<!-- changetour:exclude ... -->\` markers.)`);
		}
	}

	const empty = report.drifted.length === 0 && report.missingInTour.length === 0 && report.removedFromPR.length === 0;
	process.exit(empty ? 0 : 1);
}

if (require.main === module) {
	main(process.argv);
}

module.exports = { parseTourHunks, parseTourExclusions, parsePrDiff, parseApiFiles, parsePaginatedJsonArray, computeDriftReport, editContentFingerprint, isExcluded, isGlob, matchesGlob };
