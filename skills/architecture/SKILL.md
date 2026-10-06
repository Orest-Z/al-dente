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
- Tests and stories are left out of the architecture by default. Only add an `"ignore": [globs]` list if the project keeps tests or other non-production code somewhere the defaults miss (they cover `*.test.*`, `*.spec.*`, `__tests__/`, `__mocks__/`, `test/`, `tests/`, `e2e/`, `*.stories.*`).

## New project

1. If it's unclear what the app does, ask in one question.
2. Before designing: if existing tools already do this, name them in a line or two, so the user can decide whether to build at all. Check that this machine has what each option needs (for example `node --version`, `rustc --version`) and say what's missing.
3. Propose 2–3 architectures in plain language. For each, give:
   - its parts and which part may use which, as a short picture (`Screens → Features → Data`, with Shared under everything). This becomes the rules al-dente enforces, so show the real arrows, not only the tech stack;
   - who it suits, and its trade-off;
   - any code al-dente can't check (anything that isn't TypeScript/JavaScript).

   Recommend one and say why.
4. Wait for the user to choose. Then write `al-dente.json` and create the folders. If its parts or uses differ from the picture the user chose, say what changed and why.
5. If the plan rests on something unproven (an API, a runtime, a library), build the smallest test of that first. If it can't be tested yet, say so and ask before building the rest around it.

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
