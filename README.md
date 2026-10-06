# al-dente

**Keeps your vibe-coded app from turning into spaghetti.**

al-dente is a live architecture map that your coding agent has to respect. You agree on a plan once (the parts of your app, and which part may use which). After that, every edit Claude makes is checked against the plan and shown on the map as it happens.

<!-- TODO: demo GIF here: map lights up as Claude edits, a red arrow appears, Claude fixes it -->

## How it works

1. **Decide.** Ask Claude to *"design the architecture for this app with al-dente"*. It proposes 2–3 options in plain words, you pick one, and the plan is saved to `al-dente.json`. From then on, every Claude session starts knowing the plan, so it imports the right way the first time.
2. **Watch.** Open the live map. Every edit lights up the part being changed, the arrows it touches, and the parts that might be affected.
3. **Guard.** If an edit breaks the plan (say, a UI component importing the database directly), the arrow turns red and Claude gets told right away, with the file and line, so it fixes the code itself. Only *new* breaks block: debt that's already committed never pushes Claude into refactoring files it merely touched.
4. **Review.** Every pull request gets a comment showing what it does to the architecture: a map of the parts, new or removed connections, and any rule break it adds, linked to the line. It fails only on breaks the PR adds, so you can turn it on in a repo that already has debt.

On the map, open any part to see its files, each with a one-line description (from the file's own doc comment, or summarised from its code). Hover a file to draw exactly what it imports and who imports it. Press **History** to scrub through your git history, one step per merged PR: the map shows the project as it was, the side panel lists what that PR changed and which connections it added or removed, and a drift chart marks every commit that introduced or fixed a rule break, so you can see exactly when the architecture started to slip.

## Install (Claude Code)

```
/plugin marketplace add <your-github-name>/al-dente
/plugin install al-dente@al-dente
```

Then, in your project, ask Claude to design or map the architecture. To open the map:

```bash
npx al-dente
```

## Commands

```bash
npx al-dente            # open the live map (http://localhost:4747)
npx al-dente check      # check every file once, exit 1 on rule breaks
npx al-dente diff main  # what this branch does to the architecture (Markdown); exit 1 only on breaks it adds
```

Options: `--root <dir>`, `--port <n>`, `--no-open`; for `diff`: `--head <rev>` (default: the working tree) and `--json`.

## Pull request check (GitHub Actions)

Add `.github/workflows/architecture.yml`:

```yaml
name: Architecture
on: pull_request
permissions:
  contents: read
  pull-requests: write # to keep one al-dente comment up to date
jobs:
  al-dente:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # the base branch is needed for the comparison
          ref: ${{ github.event.pull_request.head.sha }}
      - uses: Orest-Z/al-dente@main
        # with:
        #   root: apps/web    # folder with al-dente.json (default: the repo root)
        #   comment: false    # only write the job summary
```

The comment shows the parts as a diagram (new connections thick, breaks red), the new rule breaks with links to their lines, connections added or removed, edits to `al-dente.json` itself (so a loosened rule never slips through review), and the files changed per part. Pull requests from forks get a read-only token, so they get the report in the job summary instead of a comment.

## The plan file

```json
{
  "parts": {
    "screens":    { "label": "Screens",    "paths": ["src/screens"],    "uses": ["components", "features", "shared"] },
    "components": { "label": "Components", "paths": ["src/components"], "uses": ["shared"] },
    "features":   { "label": "Features",   "paths": ["src/features"],   "uses": ["data", "shared"] },
    "data":       { "label": "Data",       "paths": ["src/data"],       "uses": ["shared"] },
    "shared":     { "label": "Shared",     "paths": ["src/shared"],     "uses": [] }
  }
}
```

A file belongs to the part with the longest matching path. Imports inside a part are always fine; imports into another part must be listed in `uses`.

Tests and stories aren't architecture, so they may import anything. To choose yourself, add an `ignore` list of globs (the default is `["**/*.test.*", "**/*.spec.*", "**/__tests__/**", "**/__mocks__/**", "**/test/**", "**/tests/**", "**/e2e/**", "**/*.stories.*"]`; `[]` checks everything). Files your `.gitignore` excludes, like generated code, are skipped too.

## What it understands

Imports resolve the way TypeScript and bundlers resolve them, with zero dependencies and any TypeScript version (including the Go-based TypeScript 7):

- relative imports, index files, and ESM `.js` imports that point at `.ts` files
- `paths` and `baseUrl` from the nearest `tsconfig.json` or `jsconfig.json`, following `extends` and Vite-style `references`
- monorepos: workspace packages (`npm`, `yarn`, `pnpm`) imported by name, like `@acme/shared`

Nothing leaves your machine: the map is a local server bound to `127.0.0.1`. It's built for real repos: on a 5,000-file project a save sends the browser a few KB, the hook never waits for the map, and history is analysed in a background thread.

## Status

Early. Works with TypeScript and JavaScript projects in Claude Code. Planned next: Cursor, Codex and Gemini CLI hooks, and more languages.

Try it on the bundled example:

```bash
node bin/al-dente.js --root examples/shop
```

## License

MIT
