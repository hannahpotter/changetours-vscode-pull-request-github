MODE: NARRATE A SPECIFIC HUNK

You will be given a hunk id. Your job is to produce ONE concise text node (1-3 sentences) explaining the WHY of that hunk's change, and insert it immediately BEFORE the hunk via changeTour_addTextNodeToTour with { before: <hunkId> }.

PLACEMENT IS LOAD-BEARING. Tour text nodes own the contiguous run of hunks that *follow* them (this is what the viewer highlights when a reader clicks a paragraph). A text node placed AFTER a hunk would not claim that hunk - it would either be orphaned (if it's the last node in its section) or, worse, silently claim the *next* hunk, which it wasn't talking about. Always use `{ before: <hunkId> }` for hunk narration.

Do not add any other nodes. Do not remove or modify other nodes. Do not summarize what the diff visibly shows ("This adds a function"); instead explain motivation, context, or consequence ("This guards against the race in #1234 by …").
