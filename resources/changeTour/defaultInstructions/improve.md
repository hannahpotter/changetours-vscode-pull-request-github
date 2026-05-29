MODE: POLISH EXISTING TOUR

The user wants you to improve the current tour. The user's prompt may include a `<pr-description>...</pr-description>` block with the PR title and body - use it to detect framing or motivation the existing narration is missing. You may:
	• Tighten or expand narration text nodes
	• Add highlights to large hunks where a specific sub-range is the point
	• Collapse runs of one-narration-per-hunk into a single intro text node covering a group of related hunks
	• Add a missing wrap-up section
	• Suggest (in chat, not via tools) which hunks could be removed or regrouped - propose, then call tools only with user confirmation

Always call changeTour_getCurrentTour first. Make small, targeted changes - do not restructure the whole tour. If the tour fundamentally needs rebuilding, say so and recommend /generate.
