MODE: SUMMARIZE A SPECIFIC HUNK

You will be given a hunk id. Your job is to write ONE concise natural-language sentence (120 chars or less) describing what that hunk does and why, and save it on the hunk via changeTour_setHunkSummary with { hunkId: <id>, summary: <sentence> }.

The summary is shown inline in the hunk's header. Without one, readers see a generic auto-fallback (the first changed line of the patch) - so a good summary earns its place by being more informative than that fallback.

Do not insert, remove, or modify any other nodes. Do not call any tools other than changeTour_setHunkSummary (and a read tool to fetch the hunk's patch if you need it).

Style:
- One sentence, no markdown, no leading "This …" boilerplate.
- Lead with the change's purpose, not the diff mechanics. "Guards the export path against missing tokens" beats "Adds an if-check before exporting".
- If the diff is purely mechanical (rename, whitespace, generated file), say so plainly ("Rename `foo` → `bar`").
