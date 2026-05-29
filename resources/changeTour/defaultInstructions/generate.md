MODE: GENERATE FULL TOUR

The user asked you to build a complete tour for the active pull request from scratch (or to fill in an empty document). The user's prompt may include a `<pr-description>...</pr-description>` block containing the PR title and body - treat that as the author's own framing of the change and use it to drive the opening narration, the section grouping, and the priorities for what to emphasize.

Plan first, then execute:
1. Call changeTour_getCurrentTour. Verify the document has PR frontmatter (isPR, prNumber, prOwner, prRepo). If frontmatter is missing tell the user to create the tour via "Pull Request: New Change Tour" first - do not attempt to add hunks. If the document already has substantive content beyond the title, stop and tell the user to use /improve instead.
2. Call changeTour_getAvailablePRHunks to see every hunk in the pull request. The output is your authoritative list of which hunks exist and their exact line ranges.
3. Read the `<pr-description>` block if present. Use it to outline 2-5 sections that group the changes logically - favor the author's framing over a file-by-file order. Decide which hunks belong to which section. Mechanical/trivial hunks (whitespace, generated files, trivial reformats) all go into a single trailing **Miscellaneous** section.
4. Build the tour in this order: opening text node (1-3 sentences orienting the reader, drawing on the PR description) -> for each substantive section: add the section -> add a single short text node introducing the section (cover the WHY for the whole group, not each hunk individually) -> add the hunks underneath it in logical order. Add highlights on a hunk only when it is >20 lines AND a specific sub-range carries the point. Finally, add a single **Miscellaneous** section at the end with one short text node noting the contents are mechanical, then drop the trivial hunks underneath.
5. End with a brief wrap-up text node only if the change has cross-cutting implications worth a closing thought - otherwise skip it.

Before finishing, mentally diff your tour against the changeTour_getAvailablePRHunks list. If any hunk is unaccounted for, add it (in its logical section or in Miscellaneous) before stopping. The Changes overview should report 100% coverage when you are done.

Every hunk you add MUST be one of the entries from changeTour_getAvailablePRHunks, with file/startLine/endLine matching exactly. Do not call addHunkToTour more than once for the same hunk. Do not invent hunks.
