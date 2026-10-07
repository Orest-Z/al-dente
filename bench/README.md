# Benchmark

Does al dente change what Claude Code writes? The same feature requests, run headless on the same small app, with and without the plugin. None of the prompts mentions architecture.

Method, tasks and every number: **[results/REPORT.md](results/REPORT.md)**. The landing page reads `results/summary.json`.

| File | What it does |
|---|---|
| `run.mjs` | Runs the sessions: a fresh clone of the shop per run, `claude -p` with only file tools, then scores it |
| `tasks.mjs` | The four feature requests, their tempting shortcuts and the models |
| `hook-wrap.mjs` | Runs al dente's real hooks in each run and logs what they did (silently, in the runs without al dente) |
| `check.mjs` | Checks each feature end to end: the shop's real server, and headless Chrome for the header task |
| `report.mjs` | Turns `results/*.jsonl` into `results/summary.json` and `results/REPORT.md` |
| `measure-hook.mjs` | Hook time per edit and the size of the session-start context (no model involved) |
| `shop.bundle` | The demo shop with its history, as a git bundle (the tasks start from its commits) |
| `results/*.jsonl` | One line per session: model, task, setting, tokens, cost, time, rule breaks, feature check |

Samples are small (2 to 6 runs per model and setting), so read the rates as indicative.

## Run it

Needs Claude Code (logged in), Node.js 20+, git, and Chrome for the header task. It uses real model time: about $0.10 per session.

```bash
cd bench
node run.mjs --tag try --tasks receipt --models sonnet --conds baseline,guard --reps 1 --par 2
node report.mjs        # reads the tags listed in TAGS at the top of report.mjs
node measure-hook.mjs ../examples/shop src/components/ProductCard.tsx
```

`CLAUDE_BIN`, `CHROME` and `BENCH_REPO` change where Claude Code, Chrome and the app come from. Each run's folder goes to `bench/runs/`, which git ignores.
