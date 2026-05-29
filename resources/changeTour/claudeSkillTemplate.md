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
isPR: true
prNumber: <integer>
prOwner: <github owner>
prRepo: <github repo>
baseRef: <base branch>
---
```

**Part 2: A single H1 title** (`# ...`).

**Part 3: An ordered tree of three node kinds.**

- **group**: a markdown heading `##` through `######` that groups related nodes.
- **text**: a paragraph of narration (focus on WHY of a change or group of changes, not WHAT).
- **hunk**: a fenced block referencing one diff hunk from the bound pull request:

```
:::hunk file=<repo/relative/path> [previousFile=<old/path>] [highlights=new:14-18,old:22-25]
<full raw patch starting with the @@ -A,B +C,D @@ header>
:::
```

The directive itself only carries `file=` (and optionally `previousFile=` for renames and `highlights=` for sub-range emphasis). The line range is read from the patch body's `@@` header - do not duplicate it in the directive. `ref` defaults to `HEAD`.

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
gh pr view <num> --json number,title,baseRefName,headRefOid,body,headRepository
```

The fields you need are: `number` (`prNumber`), `title` (used for the file name and the H1), `baseRefName` (`baseRef`), and `headRepository.owner.login`/`headRepository.name` for `prOwner`/`prRepo`. If the user is working on the PR branch locally, `gh pr view` with no arg auto-detects it.

**Step 2: Compute the filename.** Sanitize the PR title: lowercase, replace whitespace and path-illegal chars (` / \ : * ? " < > |`) with `-`, strip anything outside `[a-z0-9._-]`, collapse runs of `-`, trim leading/trailing punctuation, clip to 80 chars. The final path is:

```
<repoRoot>/.changetours/<num>-<sanitized-title>.changetour.md
```

If sanitization yields an empty string, fall back to `<num>.changetour.md`.

**Step 3: Write the file with the frontmatter pre-filled and an H1 matching the PR title.**

```
---
isPR: true
prNumber: <num>
prOwner: <owner>
prRepo: <repo>
baseRef: <baseRefName>
---

# <PR title>

```

**Step 4: Populate the tour.** Read the PR body and use it as the author's framing (see "Editing the tour" below).

## Editing the tour

Whether you bootstrapped the tour or are editing an existing one, **run the preflight checks above first** unless this is a trivial edit (typo fix, narration polish) that needs no PR data.

1. **Use the PR description as framing.** `gh pr view <num> --json title,body` gives you the author's own description. Lean on it for the opening narration and to decide how to group changes - prefer the author's mental model over a file-by-file order.

2. **Cover every hunk.** Read the PR diff with `gh pr diff <num>` (or, for an exact view, read the file directly). Group hunks into 2-5 logical sections that match the PR description. Mechanical hunks (whitespace, generated files, trivial reformats) go into a single trailing section titled **Miscellaneous** with one short text node explaining the section groups low-substance changes - do not narrate them individually.

3. **Group narration.** A short text node + multiple hunks underneath it is the typical shape. Avoid writing a separate text node for every hunk in a tight group - long stretches of narration-hunk-narration-hunk are bad UX. Prefer one short text node per logical change, even if that change spans multiple hunks.

4. **Hunk body must include the full patch.** The body between `:::hunk file=...` and the closing `:::` is the raw patch text. It MUST begin with an `@@ -A,B +C,D @@` header. The validator (next section) cross-checks this against the live PR diff.

5. **Highlights are optional.** Use `highlights=new:14-18,old:22-25` only when the hunk is >20 lines AND a specific sub-range carries the point.

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

If that exits non-zero, address the reported uncovered hunks before declaring done.

## Style summary

- Open with a section that orients the reader on what the PR is about, drawing on the PR body.
- Group related changes under descriptive headings ("Data model", "API surface", "Tests" - pick whatever matches the PR's structure).
- One short text node per logical change, even if it spans multiple hunks.
- Hunks that are mechanical go into a single trailing **Miscellaneous** section.
- Narration explains WHY, not WHAT - the diff already shows what changed.
- Run the validator after each significant edit.
