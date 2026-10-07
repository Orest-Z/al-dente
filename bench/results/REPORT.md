# al dente benchmark

Generated 2026-10-07T00:35:23.693Z. 83 valid runs (49 dropped: they never reached the model, e.g. a usage limit).

## Method

- The same feature requests, sent to Claude Code headless (`claude -p`), on a fresh copy of a small TypeScript shop with a Layered plan (Web → Shared; API → Auth, Shop; Auth, Shop → Data; Data → Shared).
- No prompt mentions architecture. User settings and plugins are switched off (`--setting-sources project,local`); only file tools are allowed.
- **Without al dente:** a silent observer runs al-dente's real check after every edit and logs it; Claude is never told. **With al dente:** the plugin as shipped (plan at session start + the guard after every edit). **Guard only:** the guard without the plan up front.
- Scored after each run: new rule breaks versus the starting commit (`al-dente diff`), and whether the feature works end to end (a real server; a real headless browser for the header task).

## Tasks

- **greeting**: "In this shop app, show the signed-in customer's email in the page header, next to the existing links. Keep the change small and keep the existing pages working." Tempting shortcut: the browser page imports the server's auth code (Web → Auth).
- **receipt** (a model took the shortcut at least once without al dente): "After a successful checkout, log a receipt to the server console with the order id, the total and the customer's email. Keep the change small." Tempting shortcut: checkout reaches into the accounts code for the email (Shop → Auth).
- **welcome** (a model took the shortcut at least once without al dente): "When a new customer signs up, start them with the Linen tote bag (product p1) already in their cart. Keep the change small." Tempting shortcut: sign-up reaches into the cart code (Auth → Shop).
- **orders**: "Add order history to this shop: a GET /api/orders endpoint that returns the signed-in customer's past orders, newest first, and a "My orders" page in the browser app, linked from the header." Tempting shortcut: the route reads the order store directly (API → Data).

## Headline

| Condition | Runs that ended with a rule break | Features working | Mean cost | Mean time |
|---|---|---|---|---|
| Without al dente | 13/35 (37%) | 35/35 | $0.105 | 29.8s |
| With al dente | 0/35 (0%) | 35/35 | $0.101 | 32s |
| Guard only (no plan up front) | 0/13 (0%) | 13/13 | $0.066 | 19.2s |

On the tempting tasks only (receipt, welcome):

| Condition | Runs that ended with a rule break | Runs where the shortcut was written at all | Mean cost |
|---|---|---|---|
| Without al dente | 13/23 (57%) | 13/23 | $0.068 |
| With al dente | 0/23 (0%) | 4/23 | $0.067 |
| Guard only (no plan up front) | 0/13 (0%) | 8/13 | $0.066 |

## Per task and model

| Task | Model | Condition | Runs | Ended broken | Shortcut written | Feature works | Mean cost | Mean output tokens | Mean time |
|---|---|---|---|---|---|---|---|---|---|
| greeting | haiku | Without al dente | 2 | 0 | 0 | 2 | $0.172 | 9243 | 98.2s |
| greeting | haiku | With al dente | 2 | 0 | 0 | 2 | $0.169 | 8147 | 88.4s |
| greeting | opus | Without al dente | 2 | 0 | 0 | 2 | $0.19 | 2781 | 26.8s |
| greeting | opus | With al dente | 2 | 0 | 0 | 2 | $0.19 | 2761 | 33.5s |
| greeting | sonnet | Without al dente | 2 | 0 | 0 | 2 | $0.098 | 2606 | 19.3s |
| greeting | sonnet | With al dente | 2 | 0 | 0 | 2 | $0.095 | 2626 | 20s |
| orders | haiku | Without al dente | 2 | 0 | 0 | 2 | $0.191 | 10542 | 107s |
| orders | haiku | With al dente | 2 | 0 | 0 | 2 | $0.196 | 12228 | 121.5s |
| orders | opus | Without al dente | 2 | 0 | 0 | 2 | $0.273 | 4682 | 39.8s |
| orders | opus | With al dente | 2 | 0 | 0 | 2 | $0.228 | 3672 | 30.9s |
| orders | sonnet | Without al dente | 2 | 0 | 0 | 2 | $0.122 | 3584 | 24.9s |
| orders | sonnet | With al dente | 2 | 0 | 0 | 2 | $0.107 | 3185 | 21s |
| receipt | haiku | Without al dente | 6 | 2 | 2 | 6 | $0.044 | 1581 | 30s |
| receipt | haiku | With al dente | 6 | 0 | 4 | 6 | $0.056 | 2401 | 38s |
| receipt | haiku | Guard only (no plan up front) | 4 | 0 | 1 | 4 | $0.042 | 1840 | 19.9s |
| receipt | opus | Without al dente | 2 | 0 | 0 | 2 | $0.121 | 1163 | 13.3s |
| receipt | opus | With al dente | 2 | 0 | 0 | 2 | $0.107 | 966 | 12.7s |
| receipt | sonnet | Without al dente | 6 | 6 | 6 | 6 | $0.068 | 1266 | 12.9s |
| receipt | sonnet | With al dente | 6 | 0 | 0 | 6 | $0.059 | 921 | 21.1s |
| receipt | sonnet | Guard only (no plan up front) | 3 | 0 | 3 | 3 | $0.093 | 2298 | 18.8s |
| welcome | haiku | Without al dente | 3 | 2 | 2 | 3 | $0.033 | 1347 | 14.1s |
| welcome | haiku | With al dente | 3 | 0 | 0 | 3 | $0.038 | 1422 | 16.4s |
| welcome | haiku | Guard only (no plan up front) | 3 | 0 | 2 | 3 | $0.05 | 2235 | 21.6s |
| welcome | opus | Without al dente | 3 | 1 | 1 | 3 | $0.126 | 1342 | 18.1s |
| welcome | opus | With al dente | 3 | 0 | 0 | 3 | $0.115 | 1037 | 11.5s |
| welcome | sonnet | Without al dente | 3 | 2 | 2 | 3 | $0.058 | 948 | 10.4s |
| welcome | sonnet | With al dente | 3 | 0 | 0 | 3 | $0.06 | 943 | 8.8s |
| welcome | sonnet | Guard only (no plan up front) | 3 | 0 | 2 | 3 | $0.086 | 1810 | 16.1s |

## The guard's loop

Runs where the guard blocked an edit: 12; ended clean: 12; median time from the block to the file being clean again: 7 s.
- more-receipt-haiku-guard-1: al-dente: src/shop/checkout.ts breaks the architecture agreed in al-dente.json.   line 6: imports "../auth/users.ts" from Auth, but Shop may only use: Data, Shared.
- r2-receipt-haiku-guard-1: al-dente: src/shop/checkout.ts breaks the architecture agreed in al-dente.json.   line 6: imports "../auth/users.ts" from Auth, but Shop may only use: Data, Shared.
- r2-receipt-haiku-guard-2: al-dente: src/shop/checkout.ts breaks the architecture agreed in al-dente.json.   line 6: imports "../auth/users.ts" from Auth, but Shop may only use: Data, Shared.

## Fixing it later instead

Follow-up sessions told about the breaks (as a code review would): 13; ended clean: 13; feature still works: 13; mean cost $0.063, 16.3s, 80904 tokens.

## Overhead (no model involved)

Guard per edit across all runs: median 80 ms, p90 126 ms (288 edits; a fresh Node process each time).

| Repo | Guard per edit (median of 15) | Plan at session start |
|---|---|---|
| shop (16 files, TypeScript) | 84 ms | ~214 tokens (856 characters / 4) |
| synthetic monorepo (4,800 files, TypeScript) | 75 ms | ~369 tokens (1475 characters / 4) |
| Django styleguide (128 files, Python) | 84 ms | ~336 tokens (1343 characters / 4) |

## Limits

- Small samples (2 to 6 runs per cell): treat rates as indicative, not precise.
- One small app and one plan. Bigger codebases and longer sessions give more chances to drift; not measured here.
- Token counts are what Claude Code reports, including cached input. The plan-size figure is characters / 4, an approximation.
