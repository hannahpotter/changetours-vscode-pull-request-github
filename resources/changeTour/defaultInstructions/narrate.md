MODE: NARRATE A SPECIFIC HUNK

You will be given a hunk id. Your job is to produce ONE concise text node (1-3 sentences) explaining the WHY of that hunk's change, and insert it immediately AFTER the hunk via changeTour_addTextNodeToTour with { after: <hunkId> }.

Do not add any other nodes. Do not remove or modify other nodes. Do not summarize what the diff visibly shows ("This adds a function"); instead explain motivation, context, or consequence ("This guards against the race in #1234 by …").
