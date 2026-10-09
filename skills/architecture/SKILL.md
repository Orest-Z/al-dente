---
name: architecture
description: Plan a new app's architecture and tech stack, or map an existing app's code into parts, as al-dente.json, which al-dente enforces on every edit and shows on a live map. Use when starting a new app, when asked to design or decide the architecture or stack, to set up al-dente, or to map existing code into parts.
---

# Architecture plan for al-dente

`al-dente.json` at the project root is the plan. Every edit is checked against it, and an import that crosses into a part it isn't allowed to use, or into a file no part claims, is sent back to you as a rule break to fix.

**Next:** for a new app, follow `new-project.md` in this skill's folder; for existing code, follow `existing-project.md`. Read only the one you need.

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
- Python: paths are package folders, like `app/api` or `src/shop/services`. A part may list several folders, such as a group of Django apps (`["shop/users", "shop/orders"]`).
- Java: paths are package folders, like `src/main/java/com/acme/shop/web`, or whole Maven or Gradle modules (`billing`, `api`). A class's folder must match its `package` line, as Maven, Gradle and IDEs expect.
- `uses`: the parts this part may import from. Imports inside a part are always allowed.
- Part order sets the map colors. Put the parts people look at most first.
- Tests, stories and migrations are left out of the architecture by default. Only add an `"ignore": [globs]` list if the project keeps tests or other non-production code somewhere the defaults miss (they cover `*.test.*`, `*.spec.*`, `__tests__/`, `__mocks__/`, `test/`, `tests/`, `e2e/`, `*.stories.*`, `test_*.py`, `*_test.py`, `conftest.py`, `migrations/*.py`, `alembic/versions/*.py`, and Java's `src/androidTest/`, `src/integrationTest/` and `src/testFixtures/`).

## Good plans

- 3–8 parts. More than that is hard to read on the map.
- Dependencies flow one way: UI-facing parts at the top, shared helpers at the bottom. Avoid cycles.
- One "shared" part for types and helpers that everything may use. Every folder a part imports from belongs to some part; only entry points, scripts and configs may stay outside.

## Rules you must follow

- Never edit `al-dente.json` to make a rule break go away unless the user explicitly agrees to the new dependency. Fix the code instead.
- To show the live map, run `node <this skill's folder>/../../bin/al-dente.js` from the project root in the background and give the user the link it prints (http://localhost:4747).
