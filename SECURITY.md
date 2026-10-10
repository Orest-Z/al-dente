# Security policy

al dente runs on your machine: a hook that Claude Code calls after every edit, and a small local server for the live map. If you find a way to misuse either, please tell me privately first.

## Reporting a vulnerability

Use GitHub's private reporting: open the **[Security tab](https://github.com/Orest-Z/al-dente/security)** of this repo and click **Report a vulnerability**. Only you and I can see the report.

Please don't open a public issue for a security problem.

Include what you can:

- what an attacker could do, and how (steps, or a small repo that shows it)
- the al dente version (the `version` in its `package.json`), your OS and your Node version

I'll reply within 7 days, keep you posted while I fix it, and credit you in the release notes unless you'd rather stay anonymous.

## Supported versions

Fixes go into the latest release only. Update with `/plugin marketplace update al-dente` (plugin) or `npx al-dente@latest` (command line).

## What al dente does on your machine

Useful to know when you judge whether something is a vulnerability:

- **No internet.** It makes no network requests. The only connection is the hook telling the local map about an edit, on `127.0.0.1`.
- **No writes.** It reads your project files and runs `git` to read history. It doesn't change your files; Claude does, through its own tools.
- **Local map server.** It listens on `127.0.0.1` only (port 4747 by default) and refuses requests whose `Host` isn't `localhost` or `127.0.0.1`, so other websites can't read your project through DNS rebinding.
- **No shell.** `git` is started directly, never through a shell, and commit IDs from the map are checked before use.
- **No dependencies.** Nothing from npm runs except al dente's own code.

Reports that break any of these promises are exactly what I want to hear about.
