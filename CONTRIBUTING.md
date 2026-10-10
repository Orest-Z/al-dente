# Contributing to al dente

Thanks for helping. Bug reports, ideas and pull requests are all welcome. The most useful thing you can send is a real case where al dente got an import wrong: a file, the plan, and what it said.

## Set up

You need Node.js 20 or newer and git. There are no dependencies to install.

```bash
git clone https://github.com/Orest-Z/al-dente
cd al-dente
npm test                                     # the whole suite, a few seconds
node bin/al-dente.js --root examples/shop    # the live map on the bundled example
```

To try your changes inside Claude Code, start it with this folder as a plugin:

```bash
claude --plugin-dir /path/to/al-dente
```

## Where things live

| Path | What it is |
|---|---|
| `src/core.js` | the plan (`al-dente.json`), the TypeScript/JavaScript import resolver, and the rule check |
| `src/python.js`, `src/java.js` | the Python and Java import readers |
| `src/hook.js`, `src/session.js` | the Claude Code hooks: check each edit, and give Claude the plan at session start |
| `src/server.js`, `ui/` | the live map: a small local server and a plain HTML/CSS/JS page |
| `src/history.js`, `src/diff.js` | history, drift and the pull request report |
| `src/survey.js` | `al-dente survey`, for mapping an existing project |
| `skills/architecture/` | the skill that tells Claude how to plan and map |
| `action.yml` | the GitHub Action |
| `test/core.test.js`, `test/fixtures/` | the tests and the small sample projects they run on |
| `bench/` | the benchmark harness behind the numbers in the README |

## Pull requests

- **Keep zero dependencies.** Everything uses Node's standard library. If you think something needs a package, open an issue first.
- **Add a test** for any bug you fix or anything you add. Language support needs a fixture in `test/fixtures/` and a test that checks both the disk and git history give the same answer, like the Python and Java tests do.
- **Run `npm test`** before you push. Every pull request runs it on Linux, Windows and macOS with Node 20, 22 and 24, and all of them must pass.
- **Match the style around you.** New source files start with the same copyright and `SPDX-License-Identifier: MIT` header as the others. Comments explain why, not what.
- **One change per pull request**, with a description of what it fixes or adds and how you tested it.
- **Hook messages are read by Claude**, so keep them short, concrete and actionable: what broke, on which line, and the allowed route.

## Adding a language

Most of the work is an import reader like `src/python.js`: find the imports in a file, resolve each one to a file in the project, and report its line. The rest of al dente (rules, map, history, PR check) works on those results unchanged. Open an issue before you start, so we can agree on what counts as an import for that language.

## Security issues

Please don't open a public issue. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE), like the rest of al dente.
