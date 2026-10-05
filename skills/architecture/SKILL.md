---
name: architecture
description: Plan or map a TypeScript/JavaScript app's architecture into al-dente.json (the parts of the app and which part may use which), which al-dente then enforces on every edit and shows on a live map. Use when starting a new app, when the user asks to design, plan or decide the architecture, to "set up al-dente", or to map an existing codebase into parts.
---

# Architecture plan for al-dente

`al-dente.json` at the project root is the plan. Every edit is checked against it, and an import that crosses into a part it isn't allowed to use is sent back to you as a rule break to fix.

## Format

```json
{
  "parts": {
    "screens":    { "label": "Screens",    "description": "Pages the user navigates to", "paths": ["src/screens"],    "uses": ["components", "features", "shared"] },
    "components": { "label": "Components", "description": "Reusable UI pieces",          "paths": ["src/components"], "uses": ["shared"] },
    "features":   { "label": "Features",   "description": "App logic",                   "paths": ["src/features"],   "uses": ["data", "shared"] },
    "data":       { "label": "Data",       "description": "Storage and API access",      "paths": ["src/data"],       "uses": ["shared"] },
    "shared":     { "label": "Shared",     "description": "Types and helpers",           "paths": ["src/shared"],     "uses": [] }
  }
}
```

- `paths`: folders (or files) relative to the project root. A file belongs to the part with the longest matching path, so `src/features/cart` can be its own part inside `src/features`.
- `uses`: the parts this part may import from. Imports inside a part are always allowed.
- Part order sets the map colors. Put the parts people look at most first.

## New project

1. If it's unclear what the app does, ask in one question.
2. Propose 2–3 architectures in plain language. For each, give: a one-line picture (`Screens → Features → Data`), who it suits, and its trade-off. Recommend one and say why.
3. Wait for the user to choose. Then write `al-dente.json` and create the folders.

## Existing project

1. Look at the folder structure and read imports in a few files per folder to see how the code really connects.
2. Propose parts that match what exists. Point out any imports that already go the "wrong way", and ask whether to allow them or plan to fix them.
3. After the user agrees, write `al-dente.json`, then run `node <this skill's folder>/../../bin/al-dente.js check` from the project root and report the result.

## Good plans

- 3–8 parts. More than that is hard to read on the map.
- Dependencies flow one way: UI-facing parts at the top, shared helpers at the bottom. Avoid cycles.
- One "shared" part for types and helpers that everything may use.

## Rules you must follow

- Never edit `al-dente.json` to make a rule break go away unless the user explicitly agrees to the new dependency. Fix the code instead.
- To show the live map, run `node <this skill's folder>/../../bin/al-dente.js` from the project root in the background and give the user the link it prints (http://localhost:4747).
