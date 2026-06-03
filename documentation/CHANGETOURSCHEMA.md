# Change Tour Schema

Every valid `.changetour.md` file has three parts.

**Part 1: YAML frontmatter** binding the tour to a PR (required, must be the first lines of the file):

```
---
schemaVersion: 1 <used for mitgrations - currently must be 1>
prNumber: <integer>
prOwner: <github owner>
prRepo: <github repo>
baseSha: <PR base commit SHA at tour-author time>
headSha: <PR head commit SHA at tour-author time>
---
```

**Part 2: A single H1 title** (`# ...`).

**Part 3: An ordered tree of three node kinds.**

- **group**: a markdown heading `##` through `######` that groups related nodes. To mark a section as collapsed-by-default in the viewer, append an HTML comment: `## My Section <!-- collapsed -->`.
- **text**: a paragraph of narration
- **hunk**: a `<details>` block referencing one diff hunk from the bound pull request. The on-disk shape is GitHub-friendly so the file renders as a collapsible syntax-highlighted diff in standard markdown viewers:

````
<details open>
<summary><code>path</code> · One-line summary</summary> (with <code>old</code> → <code>new</code> for renames)

<!-- changetour:hunk file="repo/relative/path" [previousFile="old/path"] [highlights="new:14-18,old:22-25"] [summary="authored one-line summary to override auto-fallback"] [baseBlob="<git blob SHA>"] -->

```diff
@@ -A,B +C,D @@
<full raw patch body>
```

</details>
````

Notes on the format:
- `<details open>` defaults to expanded; `<details>` (no `open` attribute) defaults to collapsed.
- The `<!-- changetour:hunk … -->` comment is the canonical machine-readable metadata; it's invisible in every renderer.
	- Only `file=` is required.
	- `previousFile` is used to specify the old file path if the file was moved.
	- `highlights` is used to bring attention to particular lines of code in the diff. `new` is used to refer to the modified line numbers and `old` is used to refer to the original line numbers of the diff.
	- `baseBlob` is used for drift detection.
- Blank lines between `<details>` / `<summary>` / metadata comment / ```diff fence are required so GitHub renders the markdown body inside the HTML correctly. The <summary> is to improve default rendering of Change Tour markdown in GitHub.