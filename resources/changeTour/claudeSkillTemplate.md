---
name: change-tour
description: Use this skill when authoring or editing a Change Tour (.changetour.md) walkthrough of a GitHub pull request. Triggers when the user references a .changetour.md file, asks to author/edit a change tour, or asks to bootstrap one for a PR.
---

# Change Tour authoring skill

A **Change Tour** is a guided walkthrough of a GitHub pull request, persisted as a `.changetour.md` file under `<repoRoot>/.changetours/`. Use this skill to edit an existing tour or bootstrap a new one for a PR.

## File format

Every valid `.changetour.md` file has three parts.

**Part 1: YAML frontmatter** binding the tour to a PR (required, must be the first lines of the file):

```
---
schemaVersion: 1
prNumber: <integer>
prOwner: <github owner>
prRepo: <github repo>
baseSha: <PR base commit SHA at tour-author time>
headSha: <PR head commit SHA at tour-author time>
---
```

`baseSha` and `headSha` are the anchors used by the future outdated-detection flow - resolve them with `gh pr view <num> --json baseRefOid,headRefOid` and copy verbatim. `schemaVersion` must be `1`.

**Part 2: A single H1 title** (`# ...`).

**Part 3: An ordered tree of three node kinds.**

- **group**: a markdown heading `##` through `######` that groups related nodes. To mark a section as collapsed-by-default in the viewer, append an HTML comment: `## My Section <!-- collapsed -->`.
- **text**: a paragraph of narration (focus on WHY of a change or group of changes, not WHAT).
- **hunk**: a `<details>` block referencing one diff hunk from the bound pull request. The on-disk shape is GitHub-friendly so the file renders as a collapsible syntax-highlighted diff in standard markdown viewers:

````
<details open>
<summary><code>repo/relative/path</code> · One-line summary</summary>

<!-- changetour:hunk file="repo/relative/path" [previousFile="old/path"] [highlights="new:14-18,old:22-25"] [baseBlob="<git blob SHA>"] -->

```diff
@@ -A,B +C,D @@
<full raw patch body>
```

</details>
````

Notes on the format:
- `<details open>` defaults to expanded; `<details>` (no `open` attribute) defaults to collapsed.
- The `<summary>` is human-visible. Use `<code>previousFile</code> → <code>file</code> · summary` for renames.
- The `<!-- changetour:hunk … -->` comment is the canonical machine-readable metadata; it's invisible in every renderer. Only `file=` is required.
- The new-side line range is derived from the patch body's `@@` header - do not duplicate it in the comment.
- Blank lines between `<details>` / `<summary>` / metadata comment / ```diff fence are required so GitHub renders the markdown body inside the HTML correctly.

## Preflight: check dependencies before doing anything else

Before running any `gh` command, verify the GitHub CLI is installed AND authenticated. If either check fails, **stop immediately** with a clear, actionable error message - do not attempt to use `gh` after a failed check, and do not wait for input.

Run these two checks in order, both with a short timeout to avoid hanging:

```
command -v gh >/dev/null 2>&1 || { echo "gh CLI is not installed"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh CLI is not authenticated"; exit 1; }
```

If `gh` is missing, print this message verbatim and stop:

> ERROR: The change-tour skill needs the GitHub CLI (`gh`) to read pull request metadata, but it is not installed. Install it with `brew install gh` (macOS), `winget install --id GitHub.cli` (Windows), or see https://cli.github.com/. After installing, run `gh auth login` and re-run this command.

If `gh` is installed but not authenticated, print this message verbatim and stop:

> ERROR: The change-tour skill needs the GitHub CLI (`gh`) to be authenticated. Run `gh auth login` and re-run this command.

Only proceed past this preflight when both checks pass.

If the user is editing a tour file that already exists AND has complete frontmatter AND does not require fetching the PR body/diff (e.g. they explicitly asked you to fix typos only), you may skip the preflight. For everything else (bootstrap, full edit, validate-with-cross-check), `gh` is required.

## Bootstrap a new tour

When the user asks you to start a tour for a PR (or hands you a PR number but no `.changetour.md` file yet), follow these steps. **Do the preflight above first** - if `gh` is unavailable, stop with the error message; do not fall back to interactively prompting the user, because this skill is often invoked non-interactively from a one-shot `claude "..."` command.

**Step 1: Resolve PR metadata via `gh`.**

```
gh pr view <num> --json number,title,baseRefOid,headRefOid,body,headRepository
```

The fields you need are: `number` (`prNumber`), `title` (used for the file name and the H1), `baseRefOid` (`baseSha`), `headRefOid` (`headSha`), and `headRepository.owner.login`/`headRepository.name` for `prOwner`/`prRepo`. If the user is working on the PR branch locally, `gh pr view` with no arg auto-detects it.

**Step 2: Compute the filename.** Sanitize the PR title: lowercase, replace whitespace and path-illegal chars (` / \ : * ? " < > |`) with `-`, strip anything outside `[a-z0-9._-]`, collapse runs of `-`, trim leading/trailing punctuation, clip to 80 chars. The final path is:

```
<repoRoot>/.changetours/<num>-<sanitized-title>.changetour.md
```

If sanitization yields an empty string, fall back to `<num>.changetour.md`.

**Step 3: Write the file with the frontmatter pre-filled and an H1 matching the PR title.**

```
---
schemaVersion: 1
prNumber: <num>
prOwner: <owner>
prRepo: <repo>
baseSha: <baseRefOid>
headSha: <headRefOid>
---

# <PR title>

```

**Step 4: Populate the tour.** Read the PR body and use it as the author's framing (see "Editing the tour" below).

## Editing the tour

Whether you bootstrapped the tour or are editing an existing one, **run the preflight checks above first** unless this is a trivial edit (typo fix, narration polish) that needs no PR data.

1. **Use the PR description as framing.** `gh pr view <num> --json title,body` gives you the author's own description. Lean on it for the opening narration and to decide how to group changes - prefer the author's mental model over a file-by-file order.

2. **Cover every hunk.** Read the PR diff with `gh pr diff <num>` (or, for an exact view, read the file directly). Group hunks into 2-5 logical sections that match the PR description. Mechanical hunks (whitespace, generated files, trivial reformats) go into a single trailing section titled **Miscellaneous** with one short text node explaining the section groups low-substance changes - do not narrate them individually.

3. **Group narration.** Prefer one short text node per logical change, even if that change spans multiple hunks. Avoid writing a separate text node for every individual hunk - long stretches of narration-hunk-narration-hunk are bad UX. Within a section, either shape is fine: (a) one intro text node followed by all the hunks underneath it (use this when the section is one coherent change); or (b) interleaved sub-groups - intro paragraph, a few related hunks, a second short paragraph that pivots to the next sub-theme, a few more hunks, and so on (use this when the section genuinely spans multiple sub-themes that read better with a pivot sentence between them than as one undifferentiated block). Each mid-section paragraph must mark a real shift; never add one just to gloss a single hunk.

4. **Hunk body must include the full patch.** The body inside the ```diff fence is the raw patch text. It MUST begin with an `@@ -A,B +C,D @@` header. The validator (next section) cross-checks this against the live PR diff.

5. **Highlights are optional.** Use `highlights="new:14-18,old:22-25"` (inside the metadata comment) only when the hunk is >20 lines AND a specific sub-range carries the point.

6. **`baseBlob` is optional but recommended.** Stamp it from the PR file API's `sha` field for the file at PR head (`gh api repos/<owner>/<repo>/pulls/<num>/files | jq '.[].sha'`). The outdated-detection feature uses it as the per-hunk anchor for drift checks.

7. **Never set `pinned="true"` yourself.** This attribute is set by the editor's pin button when an author wants to keep a drifted hunk as historical context without triggering the "tour is outdated" banner. If you're rewriting an existing hunk that has `pinned="true"`, preserve it verbatim. Never add it on your own and never strip it on rewrites.

## Validate after every significant edit

The validator ships next to this skill at `.claude/skills/change-tour/validate-change-tour.js`. Run it from the repo root and fix any errors it reports before moving on:

```
node .claude/skills/change-tour/validate-change-tour.js <relPath>
```

The validator catches missing frontmatter, malformed hunk directives, missing patch bodies, and bad highlight syntax. If `gh` is installed and authenticated, it also:

- **Rejects hunks not in the PR**: any hunk whose file path or line range doesn't match a real PR hunk is reported as an error, with the available ranges listed so you can correct them.
- **Warns about PR hunks not covered by the tour**: every hunk in the PR should appear in the tour. Hunks the tour omits are reported as warnings by default. Fix them by adding the missing hunks (group trivial ones under a **Miscellaneous** section).

Flags:

- `--require-full-coverage`: promote the coverage warnings to errors. Run with this flag after a `/generate` to confirm every PR hunk landed in the tour.
- `--skip-pr-check`: skip the live diff cross-check (works offline, but loses both the validity and coverage checks).

Exit 0 means the tour passed. After a `/generate` or similar full-build run, end with:

```
node .claude/skills/change-tour/validate-change-tour.js <relPath> --require-full-coverage
```

## Updating an existing tour (drift detection)

When the user asks you to **update** a tour whose underlying PR has moved on, do NOT eyeball the diff to guess what drifted. The bundled drift report script computes the exact set of stale and missing hunks for you:

```
node .claude/skills/change-tour/drift-report-change-tour.js <relPath> --json
```

Output shape:

```json
{
	"drifted":       [{ "tourNodeId": "<file>:<oldLines>", "file": "...", "oldLines": "L-L", "reason": "..." }],
	"missingInTour": [{ "file": "...", "startLine": N, "endLine": M }],
	"removedFromPR": [{ "tourNodeId": "<file>:<oldLines>", "file": "...", "oldLines": "L-L" }]
}
```

This is the **ground truth**. Patch-content drift is impossible to derive reliably from line ranges alone, so don't try. The script's output is what the in-extension assistant uses too; trust it.

### Update workflow

1. Run the drift report (above) to get the three lists.
2. For every entry in `drifted`:
   - Find the entry in the tour file (search for `file=` and the `oldLines` range in the metadata comments).
   - Remove the entire `<details> … </details>` block.
   - Read `gh pr diff <num>` to find the current PR hunk(s) for that file. The relevant replacement is usually the hunk whose new-side range is closest to (or overlaps) the tour's old `oldLines`.
   - Insert a fresh `<details>` block at the same position with the current PR patch. Stamp a fresh `baseBlob` from `gh api repos/<owner>/<repo>/pulls/<num>/files | jq '.[].sha'`. Preserve any `summary=`, `highlights=`, and `pinned=` attributes the old block had if they still apply.
   - Audit the text node(s) immediately before and after. If they described the OLD behavior of the hunk, rewrite them to match the new behavior. If they describe the section's broader theme, leave them alone.
3. For every entry in `missingInTour`:
   - Add a fresh `<details>` block with the PR hunk, inserted into the section whose theme it best matches.
   - Add a short text node above it (1-2 sentences explaining WHY) only if the change isn't self-evident from the diff.
4. For every entry in `removedFromPR`:
   - Remove the `<details>` block and any text node whose entire content was about that hunk's file.

### Verification (do NOT skip)

After your edits, run the drift report a SECOND time. The expected output is:

```json
{ "drifted": [], "missingInTour": [], "removedFromPR": [] }
```

If any list is still non-empty, the update is incomplete. Process the remaining entries and run the report a third time. Repeat until all three lists are empty. Then run the validator (`--require-full-coverage`) to confirm the rewrite is well-formed.

The partial-update-then-stop failure mode is the most common one with this workflow. The verification step exists because of it.

If that exits non-zero, address the reported uncovered hunks before declaring done.

## Style summary

- Open with a section that orients the reader on what the PR is about, drawing on the PR body.
- Group related changes under descriptive headings ("Data model", "API surface", "Tests" - pick whatever matches the PR's structure).
- One short text node per logical change, even if it spans multiple hunks. Within a section, default to one intro text node + all the hunks underneath; if the section genuinely pivots between sub-themes, interleave a second short paragraph at the pivot point.
- Hunks that are mechanical go into a single trailing **Miscellaneous** section.
- Narration explains WHY, not WHAT - the diff already shows what changed.
- Run the validator after each significant edit.
