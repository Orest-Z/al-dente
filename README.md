<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/logo-dark.svg">
    <img src="docs/media/logo-light.svg" alt="al dente" height="64">
  </picture>
</h1>

<p align="center"><b>Keeps your vibe-coded app from turning into spaghetti.</b></p>

<p align="center">
  <a href="#install-claude-code"><img src="https://img.shields.io/badge/Claude_Code-plugin-D97757?logo=claude&logoColor=white" alt="Claude Code plugin"></a>
  <a href="#what-it-understands"><img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="#what-it-understands"><img src="https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=black" alt="JavaScript"></a>
  <a href="#what-it-understands"><img src="https://img.shields.io/badge/Python-3776AB?logo=python&logoColor=white" alt="Python"></a>
  <a href="#what-it-understands"><img src="https://img.shields.io/badge/Java-ED8B00?logo=openjdk&logoColor=white" alt="Java"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/dependencies-0-2FBF5B" alt="Zero dependencies"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-555" alt="MIT license"></a>
</p>

**al dente** is a live architecture map that your coding agent has to respect. You agree on a plan once (the parts of your app, and which part may use which). After that, every edit Claude makes is checked against the plan and shown on the map as it happens.

<p align="center">
  <a href="https://orest-z.github.io/al-dente/#demo"><img src="https://orest-z.github.io/al-dente/media/demo.gif" width="900" alt="al dente in action: Claude asks what matters and proposes stacks, the plan becomes a live map, a phone page imports server code, the arrow turns red, the hook tells Claude and Claude fixes it. Then the benchmark: rule breaks drop from 37% to 0%."></a>
</p>

<p align="center"><sub>Pick an architecture, watch it as a live map, and see a broken rule caught and fixed on the spot. <a href="https://orest-z.github.io/al-dente/#demo">Watch the full 77-second video (with sound)</a>.</sub></p>

<!-- Demo video: to play it inline here, drag demo.mp4 (al-dente-site, public/media) onto the empty line below in GitHub's README editor. GitHub hosts the upload, so it adds nothing to this repo. -->




## How it works

1. **Decide.** Ask Claude to *"design the architecture for this app with al dente"*. It asks what matters most to you (lightweight, polished UI, shipping fast…) and proposes 2–3 options in plain words, each with a tech stack fitted to that, you pick one, and the plan is saved to `al-dente.json`. For code you already have, ask it to *"map this project with al dente"*: it surveys the folders and the imports between them in one step, then proposes parts that match how the code really connects. From then on, every Claude session starts knowing the plan, so it imports the right way the first time.
2. **Watch.** Open the live map. Every edit lights up the part being changed, the arrows it touches, and the parts that might be affected.
3. **Guard.** If an edit breaks the plan (say, a UI component importing the database directly), the arrow turns red and Claude gets told right away, with the file and line, so it fixes the code itself. Only *new* breaks block: debt that's already committed never pushes Claude into refactoring files it merely touched.
4. **Review.** Every pull request gets a comment showing what it does to the architecture: a map of the parts, new or removed connections, and any rule break it adds, linked to the line. It fails only on breaks the PR adds, so you can turn it on in a repo that already has debt.

On the map, open any part to see its files, each with a one-line description (from the file's own doc comment, or summarised from its code). Hover a file to draw exactly what it imports and who imports it. Press **History** to scrub through your git history, one step per merged PR: the map shows the project as it was, the side panel lists what that PR changed and which connections it added or removed, and a drift chart marks every commit that introduced or fixed a rule break, so you can see exactly when the architecture started to slip.

## Why al dente

- **The plan you approve becomes the rules.** No config to write by hand: you pick an architecture in plain words, and that choice is what gets enforced.
- **It's live, and the agent feels it.** Diagram tools give you a snapshot that goes stale; import linters run later, in CI. al dente checks each edit the moment Claude makes it and hands the problem straight back.
- **Old debt doesn't nag.** Only breaks an edit or a pull request *adds* count, so you can turn it on in a messy repo today.

## Supported

| | Works today | Coming next |
|---|---|---|
| **Languages** | <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript"> <img src="https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=black" alt="JavaScript"> <img src="https://img.shields.io/badge/Python-3776AB?logo=python&logoColor=white" alt="Python"> <img src="https://img.shields.io/badge/Java-ED8B00?logo=openjdk&logoColor=white" alt="Java"> | <img src="https://img.shields.io/badge/Kotlin-planned-555?logo=kotlin&logoColor=white" alt="Kotlin (planned)"> <img src="https://img.shields.io/badge/C%23_%2F_.NET-planned-555?logo=dotnet&logoColor=white" alt="C# / .NET (planned)"> <img src="https://img.shields.io/badge/Go-later-555?logo=go&logoColor=white" alt="Go (later)"> |
| **Coding agents** | <img src="https://img.shields.io/badge/Claude_Code-D97757?logo=claude&logoColor=white" alt="Claude Code"> | <img src="https://img.shields.io/badge/Cursor-planned-555?logo=cursor&logoColor=white" alt="Cursor (planned)"> <img src="https://img.shields.io/badge/Codex_CLI-planned-555" alt="Codex CLI (planned)"> <img src="https://img.shields.io/badge/Gemini_CLI-planned-555?logo=googlegemini&logoColor=white" alt="Gemini CLI (planned)"> |
| **Pull requests** | <img src="https://img.shields.io/badge/GitHub_Actions-2088FF?logo=githubactions&logoColor=white" alt="GitHub Actions"> | |

## Install (Claude Code)

```
/plugin marketplace add Orest-Z/al-dente
/plugin install al-dente@al-dente
```

Needs [Node.js](https://nodejs.org) 20 or newer and git on your PATH: the hooks run on Node, and Claude Code's native installer doesn't include it.

Then, in your project, ask Claude to design or map the architecture, and to open the live map. From a terminal, the same map is `npx al-dente` (the npm package is coming soon; until then, `node bin/al-dente.js` from a clone).

## Commands

```bash
npx al-dente            # open the live map (http://localhost:4747)
npx al-dente check      # check every file once, exit 1 on rule breaks
npx al-dente survey     # an existing project's folders and the imports between them (how Claude maps it into parts)
npx al-dente diff main  # what this branch does to the architecture (Markdown); exit 1 only on breaks it adds
```

Options: `--root <dir>`, `--port <n>`, `--no-open`; for `diff`: `--head <rev>` (default: the working tree) and `--json`. Until the npm release, run them as `node bin/al-dente.js …` from a clone.

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
      - uses: Orest-Z/al-dente@v1
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

A file belongs to the part with the longest matching path. Imports inside a part are always fine; imports into another part must be listed in `uses`. In Java, a path is a package folder (`src/main/java/com/acme/shop/web`) or a whole Maven or Gradle module (`billing`).

A part may not import files that no part claims either, so code can't slip past the rules through a helper outside the plan. Files outside every part, like entry points and scripts, may import any part, and generated code your `.gitignore` excludes doesn't count.

Tests, stories and migrations aren't architecture, so they may import anything. To choose yourself, add an `ignore` list of globs (the default is `["**/*.test.*", "**/*.spec.*", "**/__tests__/**", "**/__mocks__/**", "**/test/**", "**/tests/**", "**/e2e/**", "**/*.stories.*", "**/test_*.py", "**/*_test.py", "**/conftest.py", "**/migrations/*.py", "**/alembic/versions/*.py", "**/src/androidTest/**", "**/src/integrationTest/**", "**/src/testFixtures/**"]`; `[]` checks everything). Files your `.gitignore` excludes, like generated code, are skipped too.

## What it understands

Imports resolve the way TypeScript and bundlers resolve them, with zero dependencies and any TypeScript version (including the Go-based TypeScript 7):

- relative imports, index files, and ESM `.js` imports that point at `.ts` files
- `paths` and `baseUrl` from the nearest `tsconfig.json` or `jsconfig.json`, following `extends` and Vite-style `references`
- monorepos: workspace packages (`npm`, `yarn`, `pnpm`) imported by name, like `@acme/shared`

Python imports resolve the way Python's import system would, from the file layout alone (no Python needed):

- `import a.b`, `from .x import y` (submodule or name), parenthesised imports over several lines, imports inside functions or `if TYPE_CHECKING:`, and `importlib.import_module("a.b")` with a literal name
- packages and modules under the project root, `src/` layouts (with or without `__init__.py`), monorepos with several packages, and plain script folders
- the standard library and installed packages are skipped; tested on Django, Flask, LangChain, FastAPI's full-stack template and nanoGPT (about 40,000 imports, no wrong matches)

Java imports resolve from the file layout and each folder's `package` line (no JDK, Maven or Gradle needed):

- `import a.b.C`, static imports, nested classes, `import a.b.*` (only the classes the file really uses from that package count), and class names written out in full in the code, like `new com.acme.data.Order()`
- Maven and Gradle layouts (`src/main/java`), Android apps, multi-module builds (when two modules have a class with the same name, the nearer one wins) and plain `src/` folders; Maven's `target/` output is skipped
- the JDK and libraries are skipped; tested on Spring Petclinic, JHipster's sample app, NewPipe, JUnit 5, Guava and Kafka (about 75,000 project imports, no wrong matches)

Nothing leaves your machine: the map is a local server bound to `127.0.0.1`. It's built for real repos: on a 5,000-file project a save sends the browser a few KB, the hook never waits for the map, and history is analysed in a background thread.

## Status

Early, and moving fast: TypeScript, JavaScript, Python and Java projects in Claude Code today; see [Supported](#supported) for what's next. Issues and ideas are welcome.

Try it on the bundled example:

```bash
node bin/al-dente.js --root examples/shop
```

## License

MIT © 2026 [Orest Zogju](https://github.com/Orest-Z). See [LICENSE](LICENSE).
