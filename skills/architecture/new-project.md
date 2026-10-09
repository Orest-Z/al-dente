# New project

The whole decision takes the user two clicks: one for what they care about, one for the architecture. Use the `AskUserQuestion` tool for both. If it isn't available (for example in a headless `claude -p` run), ask the same thing as a short numbered list in text and wait for the reply.

1. **Understand the idea.** If it's unclear what the app does, ask in one plain question. Work out what you can yourself: where it runs from the idea ("a habit tracker app" is mobile), and the language from any files already in the folder. If existing tools already do this, name them in a line or two, so the user can decide whether to build at all.

2. **Click 1: what matters.** One `AskUserQuestion` call with these questions, minus any the user already answered:
   - *"What matters most for this app?"* (header `Priority`, single select):
     - **Lightweight**: small, fast, few dependencies, cheap to host
     - **Looks & feel**: polished UI, animation, great UX
     - **Ship fast**: familiar tools, batteries included
     - **Grows big**: many users, a team, years of life
   - *"Which languages are you comfortable with?"* (header `Languages`, multi select): **TypeScript / JavaScript**, **Python**, **C# / Java**, **None, pick for me**.
   - *"Where does it run?"* (header `Platform`): only if step 1 couldn't tell. **Web**, **Mobile**, **Desktop**, **API / CLI**.

   The tool adds "Other" by itself, so the user can type something else. If they're unsure or have no preference, design for a solo developer shipping a first version.

3. **Design 2–3 architectures**, different on purpose so the choice is real (for example a lean one, a polished one and a batteries-included one). Each has:
   - **its parts and which part may use which**. This becomes the rules al-dente enforces, so get the arrows right;
   - **its stack**: language, framework, and the few libraries that matter (UI kit, data layer, auth, hosting), each fitted to the user's priority. See "Choosing the stack";
   - who it suits, and its trade-off;
   - **what al-dente can't check**. al-dente reads TypeScript, JavaScript, Python and Java. A part written in another language (C#, Kotlin, Go, Rust, Swift, Dart, PHP, Ruby, …) won't show on the live map and its imports won't be checked. C# and Kotlin support is planned; the others are not yet. Never drop the best stack because al-dente can't read it: give the warning and let the user choose;
   - what this machine is missing to build it. Check quietly (`node --version`, `python --version`, `dotnet --version`, …).

4. **Click 2: the choice.** Before the question, write two or three sentences: which option you recommend and why, tied to the user's priority. No longer write-up. Then one `AskUserQuestion` call, single select, header `Architecture`, one option per architecture, the recommended one first with " (Recommended)" at the end of its label. Each option has:
   - `label`: a 1–5 word name, like "Lean web app";
   - `description`: the stack and the trade-off in one sentence. It must make sense alone, since not every screen shows the preview;
   - `preview`: the full picture, in this shape:

     ```
     Lean web app

     Screens → Features → Data
          ↘       ↓       ↙
              Shared

     Stack   SvelteKit · Hono · SQLite (Drizzle)
     Why     ~40 KB of JS, one process, free hosting
     Suits   solo, small audience; smaller ecosystem than React
     Guard   ✓ every part checked by al-dente
     Needs   ✓ Node 24 installed
     ```

     When parts can't be checked, the `Guard` line says which: `⚠ Unity client (C#) not on the map yet (support planned)`. When a tool is missing, `Needs` says so: `✗ .NET SDK not installed`.

5. **After the choice:** write `al-dente.json` and create the folders. If its parts or uses differ from the chosen picture, say what changed and why. Only list parts whose code al-dente can read, and name the ones left out; if none can be read, say al-dente can't guard this project yet and don't write the file. Then start the live map (see "Rules you must follow" in SKILL.md) and give the user the link, so they see their plan as boxes before any code exists.

6. If the plan rests on something unproven (an API, a runtime, a library), build the smallest test of that first. If it can't be tested yet, say so and ask before building the rest around it.

## Choosing the stack

- Let the user's priority decide, not habit. Don't reach for the same stack every time.
  - **Lightweight:** fewest moving parts. Plain HTML/CSS with a little JS, or a small framework (Svelte, Preact, Astro for mostly static sites). Small servers (Hono, Fastify, FastAPI, Go). SQLite before a database server. Static hosting when there's no backend. Say the size or memory cost when it decides the choice (Tauri over Electron for desktop).
  - **Looks and feel:** a framework with a strong component and animation ecosystem (React or Next.js with Tailwind, shadcn/ui or Radix, Motion; or SvelteKit). For mobile, React Native with Expo, or Flutter for pixel-level control; SwiftUI or Jetpack Compose for the most native feel. Mention accessibility and design tokens.
  - **Ship fast:** batteries included and the user's own language (Next.js, Django, Rails, Laravel). Hosted auth and database (Supabase, Firebase) when they save real work.
  - **Grows big:** typed end to end, clear module boundaries, a real database (Postgres), tests from day one. Typed languages (TypeScript, C#, Java, Kotlin, Go) are worth their cost here.
- Recommend only mature, maintained tools with a real community. If you aren't sure something is still maintained, or of its current major version, check before recommending it. Never suggest a deprecated library.
- Keep each stack small: one framework per layer, and no extra libraries the app doesn't need yet.
- Fit the stack to the parts: the arrows in the picture should be natural in that framework (for example Next.js `app/` routes as Screens, server actions in Features).
- When the user knows a language, prefer stacks in it unless another one is clearly better for their priority; then say why it's worth learning.
