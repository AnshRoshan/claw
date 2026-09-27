# CLAW for VS Code — design & scaffold

A thin VS Code extension that puts the **whole of CLAW** — the same agent,
tools, guard stack, and sessions — inside the editor. The extension contains
**zero agent logic**; it is a client of the `claw serve` HTTP channel.
That's the point: build the agent once (anywhere), and every surface
— terminal, browser, editor — is a client of the same loop.

## Architecture

```
┌─────────────────────────────┐
│  VS Code                    │
│  ┌───────────────────────┐  │  postMessage bridge      ┌──────────────────┐
│  │ Webview (chat panel)  │←─┼─────────────────────────►│ extension.js     │
│  │ HTML/CSS/JS, no build │  │   (webviews can't fetch  │  - spawns/attaches│
│  └───────────────────────┘  │    localhost themselves, │    claw serve    │
│                              │    the host proxies)     │  - fetch proxy   │
└─────────────────────────────┘                              └────────┬─────────┘
                                                                      │ HTTP
                                                       POST /chat     │ GET /health
                                                       GET  /health   ▼
                                                            ┌──────────────────┐
                                                            │ claw serve       │
                                                            │  one TAOR loop   │
                                                            │  tools + guards  │
                                                            │  sessions (JSONL)│
                                                            └──────────────────┘
```

Why a postMessage bridge? VS Code webviews run in a locked-down iframe that
cannot `fetch()` arbitrary localhost URLs. The extension host (Node) does
the fetch and relays — ~30 lines, and it also gives us one place to add
auth later. The chat UI itself is the same design as the built-in web UI in
`src/serve.ts` (`GET /`).

## What's in this scaffold

| File | What it does |
| --- | --- |
| `package.json` | Extension manifest: commands, settings, code-lens, activation events |
| `extension.js` | Server lifecycle (spawn/attach), webview panel, SSE relay bridge, `explain selection`, diagnostic code lens |
| `README.md` | This file |

**Commands**

- **Claw: Open Chat** — opens the streamed chat webview (starts the server
  if needed); tokens render live via the SSE `/chat` stream.
- **Claw: Explain Selection** — sends the selected code (with file + line
  context) as a chat message; answer lands in the panel.
- **Claw: Fix This Diagnostic** — code lens on every editor diagnostic;
  sends file, line, severity, message, and snippet so the *agent* (which
  owns `read_file`/`edit_file`) fixes it with its own tools.
- **Claw: Restart Server** — kills and respawns the serve process.

**Settings**

- `claw.serverUrl` — attach to an already-running `claw serve`
  (default `http://127.0.0.1:8787`).
- `claw.cliPath` — how to spawn claw if not running: a `claw` command on
  PATH, or the absolute path to this repo's `src/cli.ts`.

## Run it

1. Start the agent side (or let the extension spawn it):
   ```bash
   cd E:\ACode\claw
   node src/cli.ts -y serve --port 8787
   ```
2. Open `claw/vscode/` in VS Code → **F5** (Run Extension) → a new window
   opens with the extension loaded.
3. `Ctrl+Shift+P` → **Claw: Open Chat**. Select some code →
   **Claw: Explain Selection**.

To package it properly: `npm i -g @vscode/vsce && vsce package` (needs a
publisher id in `package.json`).

## Why this design (and what comes next)

The VS Code extension is deliberately **the third client of one channel** —
terminal (`repl.ts`), browser (`GET /`), editor (this). Everything the
extension can do, it does by talking to `/chat` with a session id:

- **Editor context as prompt text.** Selection, diagnostics, open-file
  lists are just message text (`<file src/x.ts:10-20>…</file>`). The agent
  already has `read_file`/`grep` for everything else — never duplicate
  tools the agent already has.
- **Sessions map to editor state.** Per-workspace session ids live in
  `workspaceState`, so `claw continue` and the web UI see the same history.
- **Roadmap** (in dependency order):
  1. Diff decoration: the extension renders `edit_file`-style suggestions
     from the answer as VS Code diffs (parse fenced diffs from the reply).
  2. Code lens "fix this" — ✅ **done**: registered via a
     `CodeLensProvider` over `languages.getDiagnostics`, one lens per
     error/warning, routed through a custom command that composes the
     message and hands it to the panel bridge.
  3. Inline "fix this" on hover / quick-fix actions (same message builder
     as the code lens, registered as a `CodeActionProvider`).
  4. Terminal channel inside VS Code's integrated terminal (spawn `claw`
     REPL directly — zero extension code).
  5. Streaming — ✅ **done**: the panel consumes the SSE `/chat` stream
     (`"stream": true`) and renders deltas live.

The lesson the scaffold encodes: **an agent harness earns its keep once
non-terminal surfaces are thin clients.** The VS Code extension should
never grow a second agent — if a feature doesn't fit over `/chat`, the
feature belongs in the agent.
