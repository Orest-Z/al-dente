# al-dente

**Keeps your vibe-coded app from turning into spaghetti.**

al-dente is a live architecture map that your coding agent has to respect. You agree on a plan once (the parts of your app, and which part may use which). After that, every edit Claude makes is checked against the plan and shown on the map as it happens.

<!-- TODO: demo GIF here: map lights up as Claude edits, a red arrow appears, Claude fixes it -->

## How it works

1. **Decide.** Ask Claude to *"design the architecture for this app with al-dente"*. It proposes 2–3 options in plain words, you pick one, and the plan is saved to `al-dente.json`.
2. **Watch.** Open the live map. Every edit lights up the part being changed, the arrows it touches, and the parts that might be affected.
3. **Guard.** If an edit breaks the plan (say, a UI component importing the database directly), the arrow turns red and Claude gets told right away, with the file and line, so it fixes the code itself.

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
npx al-dente check      # check every file once, exit 1 on rule breaks (works in CI)
```

Options: `--root <dir>`, `--port <n>`, `--no-open`.

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

## Why it's accurate

Imports are read with TypeScript's own resolver, using your project's TypeScript and `tsconfig.json`. Path aliases like `@/...`, Vite-style project references, index files and `.js`-to-`.ts` imports resolve exactly like your compiler resolves them. Nothing leaves your machine: the map is a local server bound to `127.0.0.1`.

## Status

Early. Works with TypeScript and JavaScript projects in Claude Code. Planned next: Cursor, Codex and Gemini CLI hooks, and more languages.

Try it on the bundled example:

```bash
node bin/al-dente.js --root examples/shop
```

## License

MIT
