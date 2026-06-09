/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Hannah Potter. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

/**
 * Represents a diff hunk reference embedded in a Change Tour document.
 *
 * On disk a hunk is a `<details>` block that GitHub (and other standard
 * markdown viewers) renders as a collapsible syntax-highlighted diff:
 *
 *   <details open>
 *   <summary><code>src/api.ts</code> · Refactor handler</summary>
 *
 *   <!-- changetour:hunk file="src/api.ts" highlights="new:14-18" baseBlob="89ab…" -->
 *
 *   ```diff
 *   @@ -A,B +C,D @@
 *   …patch body…
 *   ```
 *
 *   </details>
 *
 * The visible `<summary>` is computed from (file, previousFile, summary) at
 * serialize time; the canonical machine-readable metadata lives in the
 * `<!-- changetour:hunk … -->` comment. The `<details>` `open` attribute
 * controls default-collapse. The new-side line range is derived from the
 * patch body's first `@@ -A,B +C,D @@` header at load time.
 */
export interface HighlightRange {
	side: 'old' | 'new';
	start: number;
	end: number;
}

export interface HunkReference {
	file: string;
	startLine: number;
	endLine: number;
	patch?: string;
	previousFile?: string;
	highlights?: HighlightRange[];
	/** When true, viewers open the tour with this hunk pre-collapsed (override-able). */
	defaultCollapsed?: boolean;
	/**
	 * One-line natural-language description shown inline in the hunk header
	 * (both edit and viewer modes). When empty, the displayed text falls back
	 * to the first changed line of the patch; in edit mode the editor is
	 * pre-filled with that auto-default so authors can directly edit it.
	 */
	summary?: string;
	/**
	 * Git blob SHA of the new-side file at the tour-author `headSha`. Together
	 * with the tour-level `headSha` this lets a future update flow detect
	 * outdated hunks: re-fetch the current blob SHA for `file`; mismatch =>
	 * the underlying code has drifted from what this hunk shows.
	 */
	baseBlob?: string;
	/**
	 * When true, the outdated-hunk detector silences this hunk: even if the
	 * underlying file has drifted from `baseBlob`, the hunk does not contribute
	 * to the tour-level "outdated" banner. The badge still renders as
	 * "History (Pinned)" so readers can tell the stale state is intentional.
	 * Set via the editor's pin button; preserved verbatim by the LLM tools.
	 */
	pinned?: boolean;
}

const SUMMARY_PREVIEW_MAX_LEN = 60;

/**
 * Resolve the summary text shown alongside a hunk's diff header.
 *
 * If the hunk has an authored `summary`, return it with `isAuto: false`.
 * Otherwise default to the first changed line of the patch (truncated).
 * For patches with no add/delete lines, fall back to the thin `L{start}-{end}`
 * label. The auto-default is what populates the editor when the author
 * hasn't yet written their own one-line description - they can edit it
 * directly to author their summary.
 */
export function getHunkSummary(hunk: HunkReference): { text: string; isAuto: boolean } {
	const authored = hunk.summary?.trim();
	if (authored) {
		return { text: authored, isAuto: false };
	}
	if (hunk.patch) {
		// Scan the patch directly for the first add/delete line rather than
		// pulling in the full ParsedDiffLine pipeline - this helper runs from
		// both webview and extension code, so the dependency surface needs to
		// stay tiny.
		for (const line of hunk.patch.split('\n')) {
			if (line.startsWith('@@') || line.length === 0) {
				continue;
			}
			if (line.startsWith('+') || line.startsWith('-')) {
				const content = line.substring(1).trim();
				if (content.length > 0) {
					const text = content.length <= SUMMARY_PREVIEW_MAX_LEN
						? content
						: content.substring(0, SUMMARY_PREVIEW_MAX_LEN - 1).trimEnd() + '…';
					return { text, isAuto: true };
				}
			}
		}
	}
	return { text: `L${hunk.startLine}-${hunk.endLine}`, isAuto: true };
}

/**
 * Parse a `highlights=` attribute value (e.g. `new:14-18,old:22-25,new:30`)
 * into a list of HighlightRange. Malformed entries are silently dropped.
 */
export function parseHighlightAttribute(value: string | undefined): HighlightRange[] | undefined {
	if (!value) {
		return undefined;
	}
	const ranges: HighlightRange[] = [];
	for (const entry of value.split(',')) {
		const m = /^(old|new):(\d+)(?:-(\d+))?$/.exec(entry.trim());
		if (!m) {
			continue;
		}
		const start = parseInt(m[2], 10);
		const end = m[3] ? parseInt(m[3], 10) : start;
		ranges.push({
			side: m[1] as 'old' | 'new',
			start: Math.min(start, end),
			end: Math.max(start, end),
		});
	}
	return ranges.length ? ranges : undefined;
}

/**
 * Serialize a list of HighlightRange into the `highlights=` attribute value,
 * coalescing adjacent or overlapping ranges on the same side. Returns
 * undefined when there's nothing to write.
 */
export function serializeHighlightAttribute(highlights: HighlightRange[] | undefined): string | undefined {
	if (!highlights || highlights.length === 0) {
		return undefined;
	}
	const parts: string[] = [];
	for (const side of ['new', 'old'] as const) {
		const sorted = highlights.filter(r => r.side === side).sort((a, b) => a.start - b.start);
		const merged: HighlightRange[] = [];
		for (const r of sorted) {
			const last = merged[merged.length - 1];
			if (last && r.start <= last.end + 1) {
				last.end = Math.max(last.end, r.end);
			} else {
				merged.push({ side, start: r.start, end: r.end });
			}
		}
		for (const r of merged) {
			parts.push(r.start === r.end ? `${side}:${r.start}` : `${side}:${r.start}-${r.end}`);
		}
	}
	return parts.length ? parts.join(',') : undefined;
}

export type TourNodeType = 'group' | 'text' | 'hunk';

export interface TourGroupNode {
	type: 'group';
	id: string;
	title: string;
	level: number;
	children: TourNode[];
	/** When true, viewers open the tour with this section pre-collapsed (override-able). */
	defaultCollapsed?: boolean;
	/** 1-indexed line in the source markdown where the heading sits. */
	sourceStartLine?: number;
	/** 1-indexed line in the source markdown - same as start for groups (header line only). */
	sourceEndLine?: number;
}

export interface TourTextNode {
	type: 'text';
	id: string;
	content: string;
	/** 1-indexed first line of the paragraph's content in the source markdown. */
	sourceStartLine?: number;
	/** 1-indexed last line of the paragraph's content in the source markdown. */
	sourceEndLine?: number;
}

export interface TourHunkNode {
	type: 'hunk';
	id: string;
	hunk: HunkReference;
}

export type TourNode = TourGroupNode | TourTextNode | TourHunkNode;

export interface CodeTourDocument {
	title: string;
	/** Format version. Currently always 1; bumps trigger an explicit migration. */
	schemaVersion?: number;
	prNumber?: number;
	prOwner?: string;
	prRepo?: string;
	/** PR base commit SHA at tour-author time. Anchors the future update flow. */
	baseSha?: string;
	/** PR head commit SHA at tour-author time. Used together with per-hunk `baseBlob` to detect drift. */
	headSha?: string;
	children: TourNode[];
	/**
	 * Parsed `<!-- changetour:exclude ... -->` markers in the body. Populated
	 * by `parseCodeTourMarkdown` so consumers (drift tools, viewer UI) don't
	 * each re-scan the raw text. Optional so callers that build a
	 * `CodeTourDocument` literal (e.g. via spread) don't need to set it
	 * explicitly; treat absence as the empty list.
	 */
	exclusions?: ExcludedHunkMarker[];
}

const DETAILS_OPEN_PATTERN = /^\s*<details(\s+open)?\s*>\s*$/;
const DETAILS_CLOSE_PATTERN = /^\s*<\/details>\s*$/;
const SUMMARY_LINE_PATTERN = /^\s*<summary>.*<\/summary>\s*$/;
const HUNK_METADATA_PATTERN = /^\s*<!--\s*changetour:hunk\s+(.*?)\s*-->\s*$/;
const EXCLUDE_MARKER_PATTERN = /<!--\s*changetour:exclude\s+(.*?)\s*-->/g;
const EXCLUDE_LINES_PATTERN = /^(\d+)-(\d+)$/;
const DIFF_FENCE_OPEN_PATTERN = /^\s*(`{3,})diff\s*$/;
const HUNK_BODY_RANGE_PATTERN = /^@@\s+-\d+(?:,\d+)?\s+\+(?<start>\d+)(?:,(?<count>\d+))?\s+@@/;
/** Legacy `:::hunk …` opener. Triggers a migration error on read. */
const LEGACY_HUNK_OPEN_PATTERN = /^:::hunk(\s|$)/;

interface HunkAttributes {
	file?: string;
	previousFile?: string;
	level?: string;
	highlights?: string;
	summary?: string;
	baseBlob?: string;
	pinned?: string;
}

/**
 * Tokenize the attribute list inside a `<!-- changetour:hunk … -->` comment.
 * Each attribute is `key=value`, separated by whitespace, in any order. All
 * attributes are optional except `file`; the new-side line range is always
 * derived from the patch body's `@@` header.
 *
 * Values can be either bare tokens (`file=path/to/x.ts`) or double-quoted
 * strings (`summary="My description with spaces"`). Inside a quoted value,
 * `\"` and `\\` are recognized as escapes for `"` and `\`.
 */
function parseHunkAttributes(attributeList: string): HunkAttributes {
	const out: HunkAttributes = {};
	const re = /(\w+)=(?:"((?:\\.|[^"\\])*)"|([^\s]+))/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(attributeList)) !== null) {
		const key = m[1] as keyof HunkAttributes;
		const value = m[2] !== undefined ? m[2].replace(/\\(["\\])/g, '$1') : m[3];
		out[key] = value;
	}
	return out;
}

/**
 * A `<!-- changetour:exclude file="..." lines="A-B" fp="..." reason="..." -->` marker.
 * Authors place these in the tour body to opt a PR hunk out of the drift /
 * coverage report - a curation tool for hunks the author deliberately left
 * out of the tour (autogenerated noise under `dist/**` / `src/generated/**`,
 * low-value mechanical changes that don't warrant individual narration, etc).
 * Without an exclusion marker those hunks would perpetually show up in
 * `missingInTour` with no way for the author to satisfy them.
 */
export interface ExcludedHunkMarker {
	/**
	 * Literal file path OR glob pattern. `isGlob` decides which at match time
	 * by looking for `*`, `?`, or `[`. Stored verbatim so round-trips don't
	 * mutate the author's input.
	 */
	file: string;
	/**
	 * Optional new-side range. When both bounds are undefined the marker is
	 * "whole-file" and matches every PR hunk in the file (or every file
	 * matching the glob). When set, both must be present. Kept for human
	 * readability in the marker; identity matching prefers `fp` when present.
	 */
	startLine?: number;
	endLine?: number;
	/**
	 * Optional edit-content fingerprint (same primitive used in drift detection).
	 * When present, matching uses fp instead of line range, so the marker
	 * survives PR rebases / commits that shift line numbers above this hunk.
	 * Computed and stored automatically for exact-range markers added via
	 * `changeTour_addExclusion`; absent on whole-file / glob markers and on
	 * older markers written before this attribute existed.
	 */
	fp?: string;
	reason?: string;
}

/**
 * True if `s` looks like a glob pattern (contains `*`, `?`, or `[`). Cheap
 * shape check - the marker grammar doesn't otherwise distinguish literal
 * paths from globs.
 */
export function isGlob(s: string): boolean {
	return /[*?[]/.test(s);
}

/**
 * Reduce a patch to a short fixed-length fingerprint of its add/remove content.
 * Two patches with byte-identical `+`/`-` lines fingerprint identically even
 * if the surrounding context, `@@` header, or line numbers differ, so this is
 * the canonical "is this the same edit?" primitive used for drift detection
 * and for the `fp` attribute on `<!-- changetour:exclude … -->` markers.
 *
 * Format: 16 hex chars = 64-bit FNV-1a hash over the UTF-8 encoding of the
 * `+`/`-` lines joined with `\n` (trailing CR stripped, so CRLF and LF
 * patches fingerprint identically). The hash form keeps markers small even
 * for whole-file deletions of multi-thousand-line generated files. The
 * algorithm is portable so external tools can produce the same output -
 * see documentation/CHANGETOURSCHEMA.md for the spec.
 */
export function editContentFingerprint(patch: string | undefined): string | undefined {
	if (!patch) {
		return undefined;
	}
	const lines: string[] = [];
	for (const rawLine of patch.split('\n')) {
		const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
		if (line.length === 0 || line.startsWith('@@')) {
			continue;
		}
		const marker = line[0];
		if (marker === '+' || marker === '-') {
			lines.push(line);
		}
	}
	if (lines.length === 0) {
		return undefined;
	}
	return fnv1a64HexOfUtf8(lines.join('\n'));
}

const TEXT_ENCODER = new TextEncoder();

// 64-bit FNV-1a over the UTF-8 encoding of `input`, rendered as 16 hex chars.
// Distinct from `fnv1a64Hex` (which hashes JS char codes - UTF-16 code units -
// and is used for node-id slugs). The UTF-8 variant is portable across
// languages (FNV-1a + UTF-8 are both widely implemented standards) so external
// tools can compute the same fp without depending on JS string encoding.
function fnv1a64HexOfUtf8(input: string): string {
	const bytes = TEXT_ENCODER.encode(input);
	let hash = FNV_OFFSET_64;
	for (let i = 0; i < bytes.length; i++) {
		hash = (hash ^ BigInt(bytes[i])) & MASK_64;
		hash = (hash * FNV_PRIME_64) & MASK_64;
	}
	return hash.toString(16).padStart(16, '0');
}

/**
 * Tiny dependency-free matcher. `*` matches one path segment (no `/`); `**`
 * matches across segments. No braces, no character classes. Predictable so
 * the CLI scripts can mirror it verbatim and stay dependency-free.
 */
export function matchesGlob(pattern: string, path: string): boolean {
	let re = '^';
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i];
		if (ch === '*' && pattern[i + 1] === '*') {
			re += '.*';
			i += 2;
		} else if (ch === '*') {
			re += '[^/]*';
			i += 1;
		} else if (ch === '?') {
			re += '[^/]';
			i += 1;
		} else {
			re += ch.replace(/[.+^${}()|\\]/g, '\\$&');
			i += 1;
		}
	}
	re += '$';
	return new RegExp(re).test(path);
}

/**
 * Scan the raw tour markdown for `<!-- changetour:exclude ... -->` markers
 * and return one entry per well-formed marker. Markers missing the required
 * `file` attribute, or with a malformed `lines` value (present but not
 * `<int>-<int>`), are silently skipped - consistent with how the hunk-
 * metadata parser tolerates partial input. A missing `lines` attribute is
 * valid and means "whole file (or whole glob)."
 */
export function parseTourExclusions(text: string): ExcludedHunkMarker[] {
	const out: ExcludedHunkMarker[] = [];
	EXCLUDE_MARKER_PATTERN.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = EXCLUDE_MARKER_PATTERN.exec(text)) !== null) {
		const attrs: Record<string, string> = {};
		const attrRe = /(\w+)=(?:"((?:\\.|[^"\\])*)"|([^\s]+))/g;
		let am: RegExpExecArray | null;
		while ((am = attrRe.exec(m[1])) !== null) {
			attrs[am[1]] = am[2] !== undefined ? am[2].replace(/\\(["\\])/g, '$1') : am[3];
		}
		if (!attrs.file) continue;
		let startLine: number | undefined;
		let endLine: number | undefined;
		if (attrs.lines !== undefined) {
			const range = EXCLUDE_LINES_PATTERN.exec(attrs.lines);
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

/**
 * True if `marker` would match the hunk identified by `(file, startLine,
 * endLine, hunkFp)`. Same semantics as `isExcluded` but for a single marker
 * -- used by the conflict-detection helpers below.
 *
 * Identity preference, when the marker carries an `fp` attribute and the
 * caller passes the hunk's current `hunkFp`: match on fingerprint. This
 * lets a marker survive PR rebases / commits that shift the hunk's line
 * numbers - the `lines=` attribute is just a human-readable cache, while
 * `fp` is the stable identity. Falls back to line-range equality when
 * either side lacks a fingerprint (older markers, or callers that don't
 * have a patch to fingerprint).
 */
function markerMatchesHunk(marker: ExcludedHunkMarker, file: string, startLine: number, endLine: number, hunkFp?: string): boolean {
	const fileMatch = isGlob(marker.file) ? matchesGlob(marker.file, file) : marker.file === file;
	if (!fileMatch) return false;
	const wholeFile = marker.startLine === undefined && marker.endLine === undefined;
	if (wholeFile) return true;
	if (marker.fp && hunkFp) {
		return marker.fp === hunkFp;
	}
	return marker.startLine === startLine && marker.endLine === endLine;
}

/**
 * True if `marker` is "exact-range" -- i.e. it carries explicit start/end
 * line bounds. The opposite of whole-file / glob.
 */
export function isExactRangeMarker(marker: ExcludedHunkMarker): boolean {
	return marker.startLine !== undefined && marker.endLine !== undefined;
}

/**
 * True if `(file, startLine, endLine, hunkFp?)` matches any exclusion marker.
 * OR across markers; file is matched by literal equality OR glob (decided by
 * `isGlob`); range is matched by fingerprint when both marker and caller
 * have one, else by exact line equality, OR trivially-true when the marker
 * has no `lines=` attribute (whole-file / whole-glob form). Pass `hunkFp`
 * (e.g. `editContentFingerprint(hunkPatch)`) wherever a patch is available
 * so markers survive PR rebases that shift line numbers.
 */
export function isExcluded(
	exclusions: ReadonlyArray<ExcludedHunkMarker>,
	file: string,
	startLine: number,
	endLine: number,
	hunkFp?: string,
): boolean {
	for (const e of exclusions) {
		if (markerMatchesHunk(e, file, startLine, endLine, hunkFp)) return true;
	}
	return false;
}

/**
 * Return every exclusion marker that would match the given hunk. Used to
 * enforce the "no overlap between tour and excluded" invariant when adding
 * a hunk to the tour: exact-range markers in this list can be auto-removed
 * (truly redundant), whole-file / glob markers should block the add (their
 * removal would un-exclude every other hunk they cover). Pass `hunkFp`
 * when available so fingerprint-bearing markers can match a drifted hunk
 * whose lines have shifted.
 */
export function findMarkersMatchingHunk(
	exclusions: ReadonlyArray<ExcludedHunkMarker>,
	file: string,
	startLine: number,
	endLine: number,
	hunkFp?: string,
): ExcludedHunkMarker[] {
	return exclusions.filter(e => markerMatchesHunk(e, file, startLine, endLine, hunkFp));
}

/**
 * Return every tour hunk in `children` (walking groups recursively) that
 * `marker` would match. Used to enforce the no-overlap invariant when adding
 * an exclusion: if this list is non-empty, the marker conflicts with the
 * curated tour and the add should be refused. `computeHunkFp` is called for
 * each hunk to derive a fingerprint when the marker carries one; callers
 * without a fingerprinter can pass `undefined` to fall back to line matching.
 */
export function findTourHunksMatchingMarker(
	children: ReadonlyArray<TourNode>,
	marker: ExcludedHunkMarker,
	computeHunkFp?: (hunk: HunkReference) => string | undefined,
): TourHunkNode[] {
	const out: TourHunkNode[] = [];
	const walk = (nodes: ReadonlyArray<TourNode>) => {
		for (const n of nodes) {
			if (n.type === 'hunk') {
				const fp = computeHunkFp?.(n.hunk);
				if (markerMatchesHunk(marker, n.hunk.file, n.hunk.startLine, n.hunk.endLine, fp)) {
					out.push(n);
				}
			} else if (n.type === 'group') {
				walk(n.children);
			}
		}
	};
	walk(children);
	return out;
}

/**
 * Return a copy of `children` with every node in `targets` removed. Walks
 * groups recursively, preserving their structure (groups stay even when
 * emptied -- the user can prune them by hand if desired). Used by the
 * "move to excluded" confirmation flow: identify conflicting tour hunks via
 * `findTourHunksMatchingMarker`, then drop them here before appending the
 * new marker.
 */
export function dropTourHunkNodes(
	children: ReadonlyArray<TourNode>,
	targets: ReadonlySet<TourHunkNode>,
): TourNode[] {
	const walk = (nodes: ReadonlyArray<TourNode>): TourNode[] => {
		const out: TourNode[] = [];
		for (const n of nodes) {
			if (n.type === 'hunk') {
				if (targets.has(n)) continue;
				out.push(n);
			} else if (n.type === 'group') {
				out.push({ ...n, children: walk(n.children) });
			} else {
				out.push(n);
			}
		}
		return out;
	};
	return walk(children);
}

/**
 * Sentinel HTML comment that marks the start of the exclusion-markers
 * appendix. Everything between this line and EOF is reserved for
 * `<!-- changetour:exclude ... -->` markers (and whitespace). The parser
 * uses the sentinel -- not a markdown heading -- to identify the appendix,
 * so `##` headings are always treated as user-authored sections regardless
 * of their title text. A user can freely name a real tour section
 * `## Excluded Changes` without colliding with the appendix.
 */
const EXCLUDED_SECTION_SENTINEL = '<!-- changetour:excluded-section -->';
const EXCLUDED_SECTION_SENTINEL_PATTERN = /^\s*<!--\s*changetour:excluded-section\s*-->\s*$/i;

/**
 * Render a `<!-- changetour:exclude ... -->` marker line. Reuses the existing
 * attribute serializer so values with whitespace / quotes get quoted+escaped
 * the same way `<!-- changetour:hunk ... -->` does. When `startLine` and
 * `endLine` are both undefined, the `lines=` attribute is omitted -- that
 * shape signals a whole-file (or whole-glob) marker to the parser.
 */
function serializeExclusionMarker(file: string, startLine: number | undefined, endLine: number | undefined, fp: string | undefined, reason?: string): string {
	const parts = [`file=${serializeHunkAttributeValue(file)}`];
	if (startLine !== undefined && endLine !== undefined) {
		parts.push(`lines=${serializeHunkAttributeValue(`${startLine}-${endLine}`)}`);
	}
	if (fp && fp.length > 0) {
		parts.push(`fp=${serializeHunkAttributeValue(fp)}`);
	}
	if (reason && reason.trim().length > 0) {
		parts.push(`reason=${serializeHunkAttributeValue(reason.trim())}`);
	}
	return `<!-- changetour:exclude ${parts.join(' ')} -->`;
}

/**
 * Lower-level append: drop `marker` into the appendix at the tail of the
 * tour. If the sentinel is already present, the marker is appended after
 * the existing ones; otherwise the sentinel is written first, followed by
 * the marker. Shared by the exact-range and whole-file/glob append helpers
 * below.
 */
function appendMarkerText(text: string, marker: string): string {
	const trimmed = text.replace(/\s+$/, '');
	if (EXCLUDED_SECTION_SENTINEL_PATTERN.test(trimmed) || trimmed.split('\n').some(l => EXCLUDED_SECTION_SENTINEL_PATTERN.test(l))) {
		return trimmed + '\n' + marker + '\n';
	}
	return trimmed + '\n\n' + EXCLUDED_SECTION_SENTINEL + '\n\n' + marker + '\n';
}

/**
 * Append a `<!-- changetour:exclude file="X" lines="A-B" ... -->` marker to
 * the tour text. Creates a trailing `## Excluded Changes` section if one isn't
 * already present. Idempotent -- if an exact-range marker for the same
 * `(file, startLine, endLine)` already exists, the text is returned
 * unchanged.
 */
export function appendExclusionMarker(text: string, file: string, startLine: number, endLine: number, fp: string | undefined, reason?: string): string {
	const existing = parseTourExclusions(text);
	for (const e of existing) {
		if (e.file === file && e.startLine === startLine && e.endLine === endLine) {
			return text;
		}
	}
	return appendMarkerText(text, serializeExclusionMarker(file, startLine, endLine, fp, reason));
}

/**
 * Append a `<!-- changetour:exclude file="PATTERN" ... -->` marker with no
 * `lines=` attribute. `filePattern` can be a literal path (excludes every
 * hunk in that file) or a glob (excludes every hunk in every file matching
 * the pattern). Idempotent -- if a whole-file marker for the same
 * `filePattern` already exists, the text is returned unchanged.
 */
export function appendWholeFileExclusionMarker(text: string, filePattern: string, reason?: string): string {
	const existing = parseTourExclusions(text);
	for (const e of existing) {
		if (e.file === filePattern && e.startLine === undefined && e.endLine === undefined) {
			return text;
		}
	}
	return appendMarkerText(text, serializeExclusionMarker(filePattern, undefined, undefined, undefined, reason));
}

/**
 * Match predicate for removal. A marker matches when its `file` attribute
 * equals `file` AND its `lines` attribute equals `linesAttr` (or both are
 * absent when `linesAttr` is `undefined`). Shared by the exact-range and
 * whole-file remove helpers.
 */
function matchesRemoveTarget(attrs: Record<string, string>, file: string, linesAttr: string | undefined): boolean {
	if (attrs.file !== file) return false;
	if (linesAttr === undefined) return attrs.lines === undefined;
	return attrs.lines === linesAttr;
}

/**
 * Lower-level remove. Walks the lines once, drops the first marker matching
 * the predicate, returns the rest verbatim. Leaves an empty
 * `## Excluded Changes` section in place if the last marker is removed --
 * harmless, and the author can delete it by hand if desired.
 */
function removeMarkerWith(text: string, file: string, linesAttr: string | undefined): string {
	const lines = text.split('\n');
	const out: string[] = [];
	let removed = false;
	for (const line of lines) {
		if (!removed) {
			const m = /<!--\s*changetour:exclude\s+(.*?)\s*-->/.exec(line);
			if (m) {
				const attrs: Record<string, string> = {};
				const attrRe = /(\w+)=(?:"((?:\\.|[^"\\])*)"|([^\s]+))/g;
				let am: RegExpExecArray | null;
				while ((am = attrRe.exec(m[1])) !== null) {
					attrs[am[1]] = am[2] !== undefined ? am[2].replace(/\\(["\\])/g, '$1') : am[3];
				}
				if (matchesRemoveTarget(attrs, file, linesAttr)) {
					removed = true;
					continue;
				}
			}
		}
		out.push(line);
	}
	return out.join('\n');
}

/**
 * Remove an exact-range `<!-- changetour:exclude ... -->` marker matching
 * `(file, startLine, endLine)`. Returns the text unchanged if no matching
 * marker is found.
 */
export function removeExclusionMarker(text: string, file: string, startLine: number, endLine: number): string {
	return removeMarkerWith(text, file, `${startLine}-${endLine}`);
}

/**
 * Remove a whole-file `<!-- changetour:exclude file="PATTERN" -->` marker
 * (no `lines=` attribute) matching `filePattern`. Returns the text
 * unchanged if no matching marker is found.
 */
export function removeWholeFileExclusionMarker(text: string, filePattern: string): string {
	return removeMarkerWith(text, filePattern, undefined);
}

/**
 * Serialize a value for use in the metadata comment attribute list. Bare
 * tokens (no whitespace, no quote) are emitted as-is; anything else is wrapped
 * in double quotes with `\` and `"` escaped.
 */
function serializeHunkAttributeValue(value: string): string {
	if (value.length > 0 && !/[\s"\\]/.test(value)) {
		return value;
	}
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * HTML-escape a string for embedding inside a `<summary>` element. The
 * `<summary>` is purely for human display; the canonical machine-readable
 * metadata lives in the adjacent `<!-- changetour:hunk … -->` comment.
 */
function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Build the full `<details>` block for a hunk, including the visible
 * `<summary>`, the metadata comment, and the fenced ```diff body. Shared
 * between `serializeCodeTourMarkdown`, `createHunkBlock`, and the webview's
 * local serializer in `codeTourEditor.tsx` (which mirrors this one).
 *
 * `level` is stamped into the metadata comment as an opaque round-trip aid
 * so the parser can pop the group stack correctly when a hunk sits at a
 * shallower nesting than its predecessor.
 */
/**
 * Pick a fenced-code-block delimiter long enough to embed `patch` without
 * being closed prematurely. The hazard is any line that matches the
 * CommonMark closing-fence pattern (<=3 leading spaces, then 3+ backticks,
 * then only whitespace) - that's exactly what a *context* line of pure
 * backticks looks like in a unified diff (context lines have a single
 * leading space prefix). Added/deleted lines start with `+`/`-` and so
 * are never closing-fence candidates; hunk headers start with `@`; trailing
 * "No newline" markers start with `\`. We pick `max(3, longest_in_body + 1)`.
 * The common case yields the existing 3-backtick fence unchanged.
 */
function pickDiffFence(patch: string): string {
	let maxFenceInBody = 2; // default return is 3 backticks
	for (const line of patch.split('\n')) {
		const m = /^ {0,3}(`{3,})\s*$/.exec(line);
		if (m && m[1].length > maxFenceInBody) {
			maxFenceInBody = m[1].length;
		}
	}
	return '`'.repeat(maxFenceInBody + 1);
}

export function buildHunkBlock(hunk: HunkReference, level?: number): string {
	const lines: string[] = [];

	lines.push(hunk.defaultCollapsed ? '<details>' : '<details open>');

	// `<summary>` is the human-visible header: `<code>file</code> · summary`
	// (or `<code>previousFile</code> → <code>file</code> · summary` for renames).
	const summaryText = getHunkSummary(hunk).text;
	const pathHtml = hunk.previousFile && hunk.previousFile !== hunk.file
		? `<code>${escapeHtml(hunk.previousFile)}</code> → <code>${escapeHtml(hunk.file)}</code>`
		: `<code>${escapeHtml(hunk.file)}</code>`;
	lines.push(`<summary>${pathHtml} · ${escapeHtml(summaryText)}</summary>`);
	lines.push('');

	// Metadata comment - the canonical attribute store. Order is stable for
	// round-trip diffability.
	const attrs: string[] = [`file=${serializeHunkAttributeValue(hunk.file)}`];
	if (hunk.previousFile) attrs.push(`previousFile=${serializeHunkAttributeValue(hunk.previousFile)}`);
	if (level !== undefined) attrs.push(`level=${level}`);
	const highlightAttr = serializeHighlightAttribute(hunk.highlights);
	if (highlightAttr) attrs.push(`highlights=${highlightAttr}`);
	if (hunk.summary && hunk.summary.trim().length > 0) {
		attrs.push(`summary=${serializeHunkAttributeValue(hunk.summary)}`);
	}
	if (hunk.baseBlob) attrs.push(`baseBlob=${serializeHunkAttributeValue(hunk.baseBlob)}`);
	if (hunk.pinned) attrs.push(`pinned=true`);
	lines.push(`<!-- changetour:hunk ${attrs.join(' ')} -->`);
	lines.push('');

	// CommonMark allows fenced code blocks of any length >= 3, with the
	// closing fence required to be at least as long as the opening one. We
	// pick the shortest fence that's longer than any backtick run already in
	// the patch body. This lets diffs whose own lines contain ``` (e.g. a
	// hunk that modifies markdown code blocks) embed cleanly without
	// closing our outer fence early.
	const fence = pickDiffFence(hunk.patch ?? '');
	lines.push(`${fence}diff`);
	if (hunk.patch) {
		lines.push(hunk.patch);
	}
	lines.push(fence);
	lines.push('');
	lines.push('</details>');

	return lines.join('\n');
}

/**
 * Read the new-side line range from the first `@@ -A,B +C,D @@` line of a
 * patch body. Returns `undefined` if no such line is found.
 */
function extractLineRangeFromPatch(patch: string | undefined): { startLine: number; endLine: number } | undefined {
	if (!patch) {
		return undefined;
	}
	for (const line of patch.split('\n')) {
		const m = HUNK_BODY_RANGE_PATTERN.exec(line);
		if (m) {
			const start = parseInt(m.groups!.start, 10);
			const count = m.groups!.count !== undefined ? parseInt(m.groups!.count, 10) : 1;
			return { startLine: start, endLine: start + Math.max(count, 1) - 1 };
		}
	}
	return undefined;
}

// Placeholder used during parsing. The real id is assigned by `assignStableIds`
// at the end of parseCodeTourMarkdown - that pass walks the parsed tree and
// derives an id from each node's content, so structural changes elsewhere in
// the tree don't shift it. Keeping a transient placeholder here keeps the
// parse code unchanged.
function genId(): string {
	return '';
}

/**
 * Walk the parsed tree and assign content-derived ids to every node. Ids are
 * stable across structural changes: adding or removing one node doesn't shift
 * any other node's id, because each id depends only on that node's own content
 * (and a small disambiguator when multiple nodes happen to share the same
 * content). This matters most for the assistant: a sequence of multiple
 * removeTourNode / addHunkToTour calls planned from a single getCurrentTour
 * snapshot would otherwise see stale ids by the second mutation.
 *
 * Duplicate-content nodes (e.g. two hunks pointing at the same file+lines, or
 * two text paragraphs with identical wording) get a `-{N}` suffix. They are
 * the one remaining instability case: removing the first occurrence renumbers
 * the rest. In practice this is rare, and the assistant tools surface a
 * recoverable "id not found, here are the current ids" error.
 */
function assignStableIds(doc: CodeTourDocument): void {
	const counters = new Map<string, number>();
	const next = (base: string): string => {
		const seen = counters.get(base) ?? 0;
		counters.set(base, seen + 1);
		return seen === 0 ? base : `${base}-${seen + 1}`;
	};
	const walk = (children: TourNode[]) => {
		for (const child of children) {
			child.id = next(baseStableId(child));
			if (child.type === 'group') {
				walk(child.children);
			}
		}
	};
	walk(doc.children);
}

function baseStableId(n: TourNode): string {
	let prefix: string;
	let payload: string;
	switch (n.type) {
		case 'hunk':
			prefix = 'h';
			payload = `${n.hunk.file}|${n.hunk.startLine}|${n.hunk.endLine}`;
			break;
		case 'text':
			prefix = 't';
			payload = n.content.trim();
			break;
		case 'group':
			prefix = 'g';
			payload = `${n.level}|${n.title.trim()}`;
			break;
	}
	return `${prefix}-${fnv1a64Hex(payload)}`;
}

// 64-bit FNV-1a hash, rendered as 16 hex chars. We avoid Node's `crypto`
// because this module is also imported by the webview bundle, where the Node
// built-in isn't available. Identity-strength only - good enough for tour node
// IDs (a few hundred per tour at most). Implemented with BigInt to stay portable
// across both Node and the webview's V8 build without polyfills.
const FNV_PRIME_64 = BigInt('0x100000001b3');
const FNV_OFFSET_64 = BigInt('0xcbf29ce484222325');
const MASK_64 = (BigInt(1) << BigInt(64)) - BigInt(1);
function fnv1a64Hex(input: string): string {
	let hash = FNV_OFFSET_64;
	for (let i = 0; i < input.length; i++) {
		hash = (hash ^ BigInt(input.charCodeAt(i))) & MASK_64;
		hash = (hash * FNV_PRIME_64) & MASK_64;
	}
	return hash.toString(16).padStart(16, '0').slice(0, 10);
}

/**
 * Try to consume a `<details>`-wrapped hunk block starting at `lines[startIdx]`.
 * Returns null if the lines don't match the canonical shape, in which case
 * the caller should fall back to treating `lines[startIdx]` as text (the
 * `<details>` tag might be authored prose, not a hunk).
 *
 * The canonical shape (with optional blank lines between each element):
 *
 *   <details> | <details open>
 *   <summary>…</summary>
 *
 *   <!-- changetour:hunk file="…" … -->
 *
 *   ```diff
 *   …patch…
 *   ```
 *
 *   </details>
 */
function tryParseHunkBlock(
	lines: string[],
	startIdx: number,
): { hunk: HunkReference; level?: number; nextIdx: number } | null {
	const openMatch = DETAILS_OPEN_PATTERN.exec(lines[startIdx]);
	if (!openMatch) {
		return null;
	}
	const isOpen = !!openMatch[1]; // matched `<details open>`
	let i = startIdx + 1;
	const skipBlanks = () => {
		while (i < lines.length && lines[i].trim() === '') i++;
	};

	skipBlanks();
	if (i >= lines.length || !SUMMARY_LINE_PATTERN.test(lines[i])) {
		return null;
	}
	i++;

	skipBlanks();
	if (i >= lines.length) {
		return null;
	}
	const metaMatch = HUNK_METADATA_PATTERN.exec(lines[i]);
	if (!metaMatch) {
		return null;
	}
	const attrs = parseHunkAttributes(metaMatch[1]);
	if (!attrs.file) {
		return null;
	}
	i++;

	skipBlanks();
	const fenceOpenMatch = i < lines.length ? DIFF_FENCE_OPEN_PATTERN.exec(lines[i]) : null;
	if (!fenceOpenMatch) {
		return null;
	}
	// The closing fence must be at least as long as the opening one (CommonMark).
	const closePattern = new RegExp(`^\\s*\`{${fenceOpenMatch[1].length},}\\s*$`);
	i++;

	const patchLines: string[] = [];
	while (i < lines.length && !closePattern.test(lines[i])) {
		patchLines.push(lines[i]);
		i++;
	}
	if (i >= lines.length) {
		return null; // unclosed ```diff fence
	}
	i++; // consume closing ```

	skipBlanks();
	if (i >= lines.length || !DETAILS_CLOSE_PATTERN.test(lines[i])) {
		return null;
	}
	i++; // consume </details>

	const patch = patchLines.join('\n').trim();
	const range = extractLineRangeFromPatch(patch || undefined);
	const hunk: HunkReference = {
		file: attrs.file,
		startLine: range?.startLine ?? 0,
		endLine: range?.endLine ?? 0,
		patch: patch || undefined,
		previousFile: attrs.previousFile,
		highlights: parseHighlightAttribute(attrs.highlights),
		defaultCollapsed: isOpen ? undefined : true,
		summary: attrs.summary && attrs.summary.trim().length > 0 ? attrs.summary : undefined,
		baseBlob: attrs.baseBlob,
		pinned: attrs.pinned === 'true' ? true : undefined,
	};
	const level = attrs.level ? parseInt(attrs.level, 10) : undefined;
	return { hunk, level: Number.isFinite(level) ? level : undefined, nextIdx: i };
}

/**
 * Parse a `.changetour.md` file into a structured document tree.
 *
 * Rules:
 * - `# Title` (h1) becomes the document title
 * - `## …` / `### …` etc. become group nodes
 * - `<details>`-wrapped diff blocks (see `tryParseHunkBlock` and `buildHunkBlock`)
 *   become hunk references
 * - Legacy `:::hunk …` directives throw a migration error
 * - Everything else is aggregated into text nodes
 */
export function parseCodeTourMarkdown(text: string): CodeTourDocument {
	const lines = text.split('\n');

	let title = '';
	let schemaVersion: number | undefined;
	let prNumber: number | undefined;
	let prOwner: string | undefined;
	let prRepo: string | undefined;
	let baseSha: string | undefined;
	let headSha: string | undefined;

	const rootChildren: TourNode[] = [];
	// Stack tracks the current nesting of groups - element 0 is shallowest.
	const groupStack: TourGroupNode[] = [];
	let pendingTextLines: string[] = [];
	let pendingTextStartLine: number | undefined;
	let pendingTextEndLine: number | undefined;

	let parseState: 'frontmatter-start' | 'frontmatter-body' | 'body' = 'frontmatter-start';

	function currentContainer(): TourNode[] {
		return groupStack.length > 0 ? groupStack[groupStack.length - 1].children : rootChildren;
	}

	function flushText(): void {
		if (pendingTextLines.length === 0) {
			return;
		}
		const content = pendingTextLines.join('\n');
		// Only add if there is actual non-whitespace content
		if (content.trim().length > 0) {
			currentContainer().push({
				type: 'text',
				id: genId(),
				content: content.trim(),
				sourceStartLine: pendingTextStartLine,
				sourceEndLine: pendingTextEndLine,
			});
		}
		pendingTextLines = [];
		pendingTextStartLine = undefined;
		pendingTextEndLine = undefined;
	}

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const lineNo = i + 1; // 1-indexed

		if (parseState === 'frontmatter-start') {
			if (line.trim() === '---') {
				parseState = 'frontmatter-body';
				i++;
				continue;
			}
			parseState = 'body';
		} else if (parseState === 'frontmatter-body') {
			if (line.trim() === '---') {
				parseState = 'body';
				i++;
				continue;
			}
			const match = /^([a-zA-Z0-9_]+)\s*:\s*(.+)$/.exec(line);
			if (match) {
				const key = match[1];
				const value = match[2].trim();
				if (key === 'schemaVersion') schemaVersion = parseInt(value, 10);
				else if (key === 'prNumber') prNumber = parseInt(value, 10);
				else if (key === 'prOwner') prOwner = value;
				else if (key === 'prRepo') prRepo = value;
				else if (key === 'baseSha') baseSha = value;
				else if (key === 'headSha') headSha = value;
				// `isPR` and `baseRef` were stored historically but were never
				// consumed by any algorithm - dropping them on read so existing
				// tours gracefully shed the dead keys on next save.
			}
			i++;
			continue;
		}

		// Reject legacy `:::hunk …` directives explicitly. Hard cutover: we
		// don't try to parse them - point the author at the migration script.
		if (LEGACY_HUNK_OPEN_PATTERN.test(line)) {
			throw new Error(
				`Line ${lineNo}: legacy ':::hunk' directive is no longer supported. ` +
				`Run \`node scripts/migrate-change-tour.js <path>\` to upgrade this tour to the new <details>-based format.`,
			);
		}

		// Appendix sentinel -- `<!-- changetour:excluded-section -->` declares
		// "everything from here to EOF is exclusion-marker metadata, not tour
		// content." Pop any open groups, flush pending text, and walk the rest
		// of the file without producing any nodes. The exclusion markers
		// themselves are picked up independently by `parseTourExclusions(text)`
		// from the raw source, so they don't need to live in `doc.children`.
		// Using a sentinel comment (instead of a `## Excluded Changes` heading)
		// keeps `##` exclusively for user-authored tour sections -- a tour can
		// freely have a section titled "Excluded Changes" that narrates real
		// content without colliding with the appendix.
		if (EXCLUDED_SECTION_SENTINEL_PATTERN.test(line)) {
			flushText();
			while (groupStack.length > 0) {
				groupStack.pop();
			}
			i = lines.length;
			continue;
		}

		// Detect headings
		const headingMatch = /^(?<hashes>#{1,6})\s+(?<text>.+)$/.exec(line);
		if (headingMatch) {
			const level = headingMatch.groups!.hashes.length;
			const headingText = headingMatch.groups!.text.trim();

			if (level === 1 && !title) {
				flushText();
				title = headingText;
				i++;
				continue;
			}

			flushText();

			while (groupStack.length > 0 && groupStack[groupStack.length - 1].level >= level) {
				groupStack.pop();
			}

			// Section authors can mark a section as collapsed-by-default with a
			// trailing HTML comment: `## My Section <!-- collapsed -->`. We strip
			// it from the title and stash the flag on the group; viewers seed
			// their initial collapsed-set from this but can still toggle it open.
			const trailingCollapsedMarker = /\s*<!--\s*collapsed\s*-->\s*$/;
			const defaultCollapsed = trailingCollapsedMarker.test(headingText);
			const cleanedTitle = defaultCollapsed
				? headingText.replace(trailingCollapsedMarker, '').trim()
				: headingText;

			const group: TourGroupNode = {
				type: 'group',
				id: genId(),
				title: cleanedTitle,
				level,
				children: [],
				sourceStartLine: lineNo,
				sourceEndLine: lineNo,
			};
			if (defaultCollapsed) {
				group.defaultCollapsed = true;
			}
			currentContainer().push(group);
			groupStack.push(group);
			i++;
			continue;
		}

		// Detect <details>-wrapped hunk blocks. Peek-ahead: if the structure
		// doesn't match, fall through and treat the `<details>` line as text
		// (authors might use `<details>` in their narration for other purposes).
		if (DETAILS_OPEN_PATTERN.test(line)) {
			const result = tryParseHunkBlock(lines, i);
			if (result) {
				flushText();

				// The level attribute (round-trip aid) tells us if this hunk
				// belongs at a shallower nesting than the deepest open group.
				if (result.level !== undefined) {
					while (groupStack.length > 0 && groupStack[groupStack.length - 1].level > result.level) {
						groupStack.pop();
					}
				}

				const hunkNode: TourHunkNode = {
					type: 'hunk',
					id: genId(),
					hunk: result.hunk,
				};
				currentContainer().push(hunkNode);
				i = result.nextIdx;
				continue;
			}
		}

		// Everything else is text. Track source lines only against non-blank lines,
		// so leading/trailing blank lines in `pendingTextLines` don't shift the
		// reported range (and the very first non-blank line still wins even when
		// blank lines have already been pushed).
		if (line.trim().length > 0) {
			if (pendingTextStartLine === undefined) {
				pendingTextStartLine = lineNo;
			}
			pendingTextEndLine = lineNo;
		}
		pendingTextLines.push(line);
		i++;
	}

	flushText();

	const result: CodeTourDocument = {
		title: title || 'Untitled Change Tour',
		schemaVersion,
		prNumber,
		prOwner,
		prRepo,
		baseSha,
		headSha,
		children: rootChildren,
		exclusions: parseTourExclusions(text),
	};
	assignStableIds(result);
	return result;
}

/**
 * Serialize a Change Tour document back into markdown text.
 */
export function serializeCodeTourMarkdown(doc: CodeTourDocument): string {
	const lines: string[] = [];

	const hasFrontmatter = doc.schemaVersion !== undefined
		|| doc.prNumber !== undefined
		|| doc.prOwner
		|| doc.prRepo
		|| doc.baseSha
		|| doc.headSha;
	if (hasFrontmatter) {
		lines.push('---');
		if (doc.schemaVersion !== undefined) lines.push(`schemaVersion: ${doc.schemaVersion}`);
		if (doc.prNumber !== undefined) lines.push(`prNumber: ${doc.prNumber}`);
		if (doc.prOwner) lines.push(`prOwner: ${doc.prOwner}`);
		if (doc.prRepo) lines.push(`prRepo: ${doc.prRepo}`);
		if (doc.baseSha) lines.push(`baseSha: ${doc.baseSha}`);
		if (doc.headSha) lines.push(`headSha: ${doc.headSha}`);
		lines.push('---');
	}

	lines.push(`# ${doc.title}`);
	lines.push('');

	function serializeNodes(nodes: TourNode[], currentLevel: number): void {
		for (const node of nodes) {
			switch (node.type) {
				case 'group': {
					const prefix = '#'.repeat(node.level);
					const suffix = node.defaultCollapsed ? ' <!-- collapsed -->' : '';
					lines.push(`${prefix} ${node.title}${suffix}`);
					lines.push('');
					serializeNodes(node.children, node.level);
					break;
				}
				case 'text':
					lines.push(node.content);
					lines.push('');
					break;
				case 'hunk': {
					lines.push(buildHunkBlock(node.hunk, currentLevel));
					lines.push('');
					break;
				}
			}
		}
	}

	serializeNodes(doc.children, 1);

	// Re-emit the trailing exclusion appendix from `doc.exclusions`. The
	// parser strips this section (recognized by the
	// `<!-- changetour:excluded-section -->` sentinel) from `doc.children`,
	// so the serializer rebuilds it here. Without this, a round-trip
	// (parse -> edit -> serialize) would silently drop every marker.
	const exclusions = doc.exclusions ?? [];
	if (exclusions.length > 0) {
		// Trim any blank trailing entries so the appendix sits flush against
		// one blank line below the last hunk/text node.
		while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
			lines.pop();
		}
		lines.push('');
		lines.push(EXCLUDED_SECTION_SENTINEL);
		lines.push('');
		for (const e of exclusions) {
			lines.push(serializeExclusionMarker(e.file, e.startLine, e.endLine, e.reason));
		}
		lines.push('');
	}

	// Trim trailing newlines to a single trailing newline
	return lines.join('\n').replace(/\n+$/, '\n');
}

/**
 * Create a hunk block suitable for inserting into a document.
 */
export function createHunkBlock(hunk: HunkReference): string {
	return buildHunkBlock(hunk);
}
