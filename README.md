> Build Code Tours of Pull Request Changes in VS Code

This extension allows you to create and review code tours of GitHub pull requests in Visual Studio Code.

# How to use
Open a pull request overview and choose to open an existing code tour file or create a new one for the pull request.

When a code tour is opened, an overview can be seen by clicking the GitHub Pull Request icon in the activity bar.

Actions to see all of the changes and open the pull request overview for a tour's associated pull request, as well as toggling edit and view modes for a tour are found in the editor tool bar.

# AI assistant
The extension includes an LLM assistant that can build Change Tours for you. It works in two modes:

- **Fully automated** - point the assistant at a pull request and it produces a complete tour (hunks selected, grouped into sections, narration written), streaming into the open editor as it works.
- **Interactive** - collaborate with the assistant turn-by-turn via chat, or use per-hunk / per-section inline buttons in the editor.

## Entry points

**Editor toolbar (✨ buttons)** - open a `.codetour.md` file created via "Pull Request: New Code Tour":
- The sparkle on the top-level toolbar auto-generates a full tour for the bound pull request.
- The sparkle on each hunk drafts narration for just that hunk and inserts it immediately after.
- The sparkle on each section improves the narration and highlights within that section only.

A streaming indicator appears at the top of the editor while the assistant is working, with a stop button to cancel.

**Chat participant `@change-tour`** - type in the Copilot Chat panel:
- `@change-tour /generate` - build a full tour for the active PR
- `@change-tour /suggest` - propose the next hunk or section to add
- `@change-tour /narrate` - draft narration for a referenced hunk
- `@change-tour /improve` - polish the current tour
- `@change-tour <free-form question>` - ask anything; the assistant may call read-only tools to ground its answer

**Claude Code CLI** - for users who prefer driving an external agent: open the command palette and run "Change Tour: Edit Change Tour with Claude Code (Terminal)". A terminal opens with a prefilled `claude` invocation containing the Change Tour format contract and a reference to the bundled validator script (`scripts/validate-change-tour.js`). The prompt instructs Claude Code to run the validator after each edit and fix any reported errors. The validator catches structural problems (missing frontmatter, malformed hunk directives, missing patch bodies, bad highlight syntax). If the `gh` CLI is installed and authenticated, it additionally cross-checks every hunk against the live pull request diff and rejects hunks whose file path or line range doesn't match a real hunk in the PR - the same validity gate the in-extension AI buttons use. Pass `--skip-pr-check` to skip the live cross-check (e.g. for offline work). Review/edit the prompt and hit Enter to launch.

## LLM provider

By default the assistant uses VS Code's language model API, so it works with whatever chat model you have installed (Copilot's GPT-4o, Copilot's Claude 3.5 Sonnet, Cody, Continue, etc.) and respects the model you've picked in the Copilot Chat dropdown.

If you don't have Copilot but do have an Anthropic API key, run "Change Tour: Set Anthropic API Key" once. The assistant will fall back to calling the Anthropic API directly. The key is stored in VS Code SecretStorage.

Relevant settings (search "Change Tour" in settings UI):
- `changeTour.assistant.enabled` - master switch (default `true`)
- `changeTour.assistant.provider` - `auto` (default), `vscode-lm`, or `anthropic`
- `changeTour.assistant.anthropicModel` - model name for the Anthropic fallback (default `claude-3-5-sonnet-latest`)
- `changeTour.assistant.maxAgentTurns` - safety cap on the agent loop (default 25)

## Notes

The assistant only generates valid tours: every hunk it inserts is resolved server-side against the bound pull request's diff, so refs and patch content are always correct. The toolbar button is disabled until the document has pull request frontmatter (created automatically by "Pull Request: New Code Tour").

# Running extension locally
[How to Build and Run](https://github.com/Microsoft/vscode-pull-request-github/wiki/Contributing#build-and-run)
> [!NOTE]
> I have been able to run this with regular VS Code (not the Insiders version)

# GitHub Pull Requests VS Code Extension

This extension is built from a fork of the [GitHub Pull Requests VS Code Extension](https://github.com/Microsoft/vscode-pull-request-github). See [its documentation](https://marketplace.visualstudio.com/items?itemName=GitHub.vscode-pull-request-github) for the GitHub features.
