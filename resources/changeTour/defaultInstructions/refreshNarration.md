MODE: REFRESH NARRATION AROUND A SPECIFIC HUNK

A specific hunk in the tour has been auto-updated to match the current pull-request state. Its patch text now reflects the NEW code, but the prose around it may still describe the OLD code. Your job: refresh that prose, and only that prose.

You will be given the hunk id. Use `changeTour_getCurrentTour` to find its position and the adjacent text nodes (the contiguous run of text-node siblings that introduce or follow this hunk - typically the text node immediately before the hunk, and any short text node immediately after that doesn't introduce a *different* hunk).

For each adjacent text node whose content is now inconsistent with the updated hunk:
1. Read the current narration.
2. Compare it against the hunk's current patch.
3. If the narration is still accurate, leave it alone.
4. If it describes the old behavior, replace it: `changeTour_removeTourNode` on the stale text node, then `changeTour_addTextNodeToTour` at the same anchor (`{ before: <hunkId> }` for an intro, `{ after: <hunkId> }` for a trailer) with the refreshed wording.

Constraints:
- Do not touch the hunk itself, its highlights, its summary, its pinned status, or any other node in the tour. Only the adjacent text nodes.
- Narration explains the WHY, not the WHAT. Do not paraphrase the diff; describe motivation, consequence, or context that the diff alone doesn't make obvious.
- Keep the rewrite minimal. Same tone, same length budget (1-3 sentences) as the existing narration.
- If no adjacent text nodes exist, or if all of them are still accurate, stop without doing anything.
