# CLAW — Build Documentation

*How everything is built, and how everything connects.* This is the living
build log for CLAW — a zero-dependency terminal coding agent written in
native TypeScript (Node ≥ 23.6, no build step, no runtime npm deps).

> **Learning the codebase?** Read [GUIDE.md](GUIDE.md) — the textbook-style
> guide to every module. This file is the chronological lab notebook.

It is being built alongside **Code with Antonio's "Build Your Own Claude
Code"** course — the YouTube tutorial *"Don't Pay for Claude Code | Build
This Instead"* ([video](https://www.youtube.com/watch?v=k_D_C3ExypU)) and its
companion repo [code-with-antonio/nightcode](https://github.com/code-with-antonio/nightcode)
(the cohort page: [codewithantonio.com](https://www.codewithantonio.com/cohorts/build-your-own-claude-code-2026-05)).

---

## 1. The two implementations, side by side

Both projects build the same thing — an agentic coding harness — with
different constraints. Understanding the mapping is the fastest way to read
either codebase.

| Concern | NightCode (Antonio) | CLAW (this repo) |
| --- | --- | --- |
| Runtime | Bun | Node ≥ 23.6 (native TS, zero deps) |
| Terminal UI | OpenTUI + React (`packages/cli`) | hand-rolled ANSI layer (`src/render.ts`) |
| API layer | Hono server (`packages/server`) | none — the CLI *is* the process (`claw serve` adds a thin HTTP adapter) |
| Persistence | Prisma + Postgres/Neon (`packages/database`) | JSONL files in `~/.claw/sessions/` (`src/sessions.ts`) |
| Auth | Clerk OAuth (PKCE, browser handshake) | API keys from env/`.claw.json` (no accounts) |
| Billing | Polar credits meter | local token/cost ledger (`src/cost.ts`) |
| AI | Vercel AI SDK streaming | direct SSE adapters (`src/providers/openai.ts`, `anthropic.ts`) |
| Shared contracts | Zod schemas + model registry (`packages/shared`) | TypeScript types (`src/types.ts`) + config aliases |
| Agent loop | AI SDK's tool-calling loop, client-side tool execution | the hand-written TAOR loop (`src/agent.ts`) |
| Tools | read/list/glob/grep/write/edit/shell (`src/lib` local tool execution) | same set + calc/web/web_search/MCP/delegate/git (`src/tools/`) |

**The core idea both share:** the model never touches your machine. It emits
structured *tool calls*; harness code decides whether they're allowed, runs
them, and feeds the results back as messages until the model answers with
plain text. Everything else is plumbing around that loop.

## 2. The three plugs (the whole architecture)

Everything reduces to three interfaces (`src/types.ts`) — the same three
organs Antonio's course builds up over its chapters:

```
Provider  "the LLM"     chat(messages, tools) → { content, toolCalls, usage }
Tool      "the hands"   execute(args) → string        (risk: safe|read|risky)
Channel   "the ears"    read() → user input           (REPL · HTTP serve)
```

And everything else is a **guard** (a hook at 7 points around the loop) or an
**organ** (session lock, iteration cap, caches, ledger, sessions).

### How one turn flows (read this twice — it's the whole system)

```
user input (Channel: repl.ts / serve.ts / cli one-shot)
   │
   ▼
Agent.runTurn(sessionKey, history)          ── session LOCK: one turn per key
   │
   ├─ guard: rate-limit                     (onTurnStart)
   ├─ response cache: exact repeat → 0 calls
   ▼
┌─ THINK ─ provider.chat(maybeCompact(history), toolDefs)   (beforeLLM)
│            │            ▲
│            │            └─ history > compactAt? summarize old msgs w/ model
│            ▼
│   guard: loop-detect       (afterLLM)
│            │
│        text only? ──► guard: secret-scan  (onTurnEnd) ──► DONE ✓
│            │
├─ ACT ─ for each tool call:
│   ├─ guard: path-confine + shell-allowlist (beforeTool)
│   ├─ guard: approval gate for risky tools  (approveTool)  ← the human
│   ├─ tool.execute(args)      ← tool cache if idempotent
│   └─ guard: output-cap + secret-scan       (afterTool)
├─ OBSERVE ─ push result as a `tool` message
└─ REPEAT ─ until text answer, error, or the iteration cap (runaway guard)
```

## 3. NightCode course chapters → CLAW equivalents

The [nightcode repo](https://github.com/code-with-antonio/nightcode) keeps
one git branch per chapter (`01-project-setup…` → `11-the-end`). Here is
where each chapter's material lives here:

| NightCode chapter / concept | CLAW location | Notes |
| --- | --- | --- |
| 01 project setup & component architecture | `package.json`, `tsconfig.json`, `src/cli.ts` | no bundler, no install — Node runs TS directly |
| 02 UI infrastructure | `src/render.ts` | ANSI panels, trace markers, streamed text |
| 03 routing / layouts | `src/repl.ts` (screens ≈ slash commands) | `/help`, `/model`, `/compact`, … |
| 04 server + database | `src/sessions.ts`, `src/config.ts` | JSONL sessions instead of Prisma/Postgres |
| 05 AI chat streaming | `src/providers/openai.ts`, `anthropic.ts` | hand-parsed SSE, canonical OpenAI wire shape |
| 06 session management | `sessions.ts` + `Agent` session lock | `claw continue`, `/resume` |
| 07 tool calling | `src/tools/*` + the ACT phase in `agent.ts` | the heart of the course |
| 08 plan vs build modes | tool `risk` levels + `riskyTools` approval gate | plan = read-only tools; build = write/shell behind the gate |
| 09 UX polish | `render.ts` trace markers, cost lines, spinner | |
| 10 billing / credits | `src/cost.ts` ledger (local, no Polar) | + per-backend budgets in the router |
| 11 client-side tool execution | `agent.ts` ACT phase + guard stack | CLAW runs tools in-process with 7 guard hook points |

## 4. Build log — session of 2026-09-06 (v0.3.0 → v0.4.0)

The v0.3.0 tree already had the loop, guards, caches, REPL, sessions,
providers, router, sub-agents, SDLC, and MCP. This session completed the
roadmap from the README's "Where to grow it". Each entry: what was built,
how it works, and where it connects.

### 4.1 git tools (`src/tools/git.ts`) — new
- **What:** `git_status` (read), `git_diff` (read), `git_log` (read),
  `git_commit` (risky).
- **How:** unlike the `shell` tool, these `spawn("git", args)` directly with
  an argv array — no shell, so no injection/chaining. A shared runner caps
  output at 10k chars and kills runaway processes at 15s. `git_commit` runs
  `git add -A` unless `add_all=false`, then `git commit -m`, then
  `rev-parse --short HEAD` so the model learns the new hash.
- **Connects:** registered in `cli.ts`'s tool list; `git_commit` is in
  `DEFAULTS.riskyTools` so the **approval guard** asks the human first
  (`-y` / `/yolo` skips). Read tools get the path-confine guard for free.
- **Verified:** selfcheck spins up a throwaway `git init` repo in tmp,
  writes/commits/diffs, then deletes it.

### 4.2 Parallel sub-agents (`src/subagent.ts`)
- **What:** `delegate` now accepts `tasks: string[]` (or a single `task`) —
  one isolated sub-agent per task, running concurrently.
- **How:** a fixed pool of `maxConcurrent` (default 4) async worker loops;
  each worker shifts one task off the queue and **awaits it before taking
  the next** (the first draft didn't await — all 4 tasks fired at once, and
  the selfcheck's in-flight counter caught it). Receipts land in the
  caller's task order, not completion order. One failing task becomes an
  `[error]` receipt instead of sinking the fan-out. Also fixed id reuse:
  `ctx.counter` is now mutated as children spawn, so session keys
  (`sub:<parent>:<n>`) never collide.
- **Connects:** same `DelegateCtx`/ledger machinery as before — every
  sub-agent's usage merges into the parent ledger; depth cap still applies;
  lifecycle events flow through the parent's trace sink (`⋮` lines).

### 4.3 Per-backend budgets (`src/providers/router.ts`)
- **What:** each router backend can declare `budget: { maxCalls?,
  maxInputTokens?, maxOutputTokens?, maxUsd? }` in `.claw.json`.
- **How:** after each successful call the router accrues the result's usage
  (USD via the same price table as the cost ledger). A backend that crosses
  any limit is "spent" and sinks to the end of the pick order — so cheap
  backends serve until their quota is exhausted before paid ones are
  touched. If *everything* is spent, calls still go through (availability
  beats frugality as a last resort). `/backends` and `claw models` show
  `budget 1/5 calls · $0.0031/$0.02 … SPENT`.
- **Connects:** `factory.buildRouter` passes budgets through; status shows
  in the REPL's `/backends`.

### 4.4 MCP sampling (`src/mcp.ts`)
- **What:** MCP servers can now call the *model* back via the
  `sampling/createMessage` request (e.g. a scraper that asks the model to
  summarize a page).
- **How:** `McpClient.dispatch` recognizes the method, flattens the server's
  messages into one prompt, and hands it to a `sampling` handler. The CLI
  wires `providerSamplingHandler(provider)` — CLAW's own model answers with
  no tools. Without a handler the client returns a clean JSON-RPC error
  instead of hanging. One HTTP-transport fix: responses to server-initiated
  requests must be POSTed too (previously `send()` only POSTed
  notifications).
- **Connects:** the test fixture server (`test/fixtures/mcp-server.ts`) grew
  an `ask_model` tool that triggers a round-trip; selfcheck proves both the
  answered and the refused paths.

### 4.5 LLM compaction (`src/agent.ts`)
- **What:** when history exceeds `compactAt` messages, the oldest block is
  now **summarized by the model** instead of silently truncated.
- **How:** `maybeCompact` splits history into `[system] + droppable +
  recent window`, sends the droppable transcript as one no-tools
  "Summarize this excerpt…" request, and replaces it with a
  `[Summary of the earlier conversation]` system message. The summary is
  memoized by a hash of the dropped prefix, so subsequent iterations of the
  same turn reuse it instead of re-summarizing. If the summarize call
  fails, it falls back to plain truncation — compaction must never lose
  the turn. Summarization usage lands in the ledger like any other call.
- **Connects:** the mock provider answers summarize prompts so the offline
  demo compacts too; the REPL's `/compact` still does instant static
  truncation (a deliberate, cheap manual override).

### 4.6 The HTTP channel (`src/serve.ts`) — new
- **What:** `claw serve [--port n] [--host addr]` runs the same agent behind
  `POST /chat { message, session_id? }` and `GET /health`.
- **How:** sessions live in a Map keyed by session id (history persists
  across requests *and* is appended to `~/.claw/sessions/<id>.jsonl`, so
  `claw continue` can pick one up). The session lock refuses concurrent
  turns on the same key — two racing POSTs get a clean "already running"
  answer instead of interleaved loops. A serve process has no TTY, so the
  approval guard **denies risky tools** by default: run with `-y` only if
  you accept that.
- **Connects:** this is the "more channels" item — the Channel plug is now
  demonstrated twice (terminal + HTTP) over one loop, which is exactly the
  many-chats-one-agent shape the architecture docs describe.

### 4.7 Tests & docs
- Selfcheck grew from 30 → **50 assertions**: router budgets, parallel
  fan-out (with a bounded-concurrency breach detector), MCP sampling (both
  paths), LLM compaction + its fallback, git tools against a real tmp repo,
  and the serve channel (health, two-turn continuity, persistence).
- README updated to v0.4.0; this file (`docs/BUILD.md`) is the living
  build record.

## 5. What's deliberately different from NightCode

- **No accounts, no server, no billing** — CLAW is a local tool; the ledger
  reports costs instead of metering credits.
- **The guard stack is the security model.** NightCode gates features
  behind auth + billing; CLAW gates *actions* behind seven hook points and
  a human approval gate. That's the part worth porting *into* other
  harnesses.
- **Zero dependencies is a feature:** every wire format (SSE, JSON-RPC,
  JSONL) is hand-parsed in the repo, so the whole harness is readable
  top-to-bottom — the same reason Antonio's course builds tools from
  scratch instead of importing an SDK.

## 6. Where to grow next

- Web UI channel (the OpenTUI-equivalent surface) on top of `serve.ts`.
- Persistent cross-run session summaries (NightCode keeps sessions in
  Postgres; we could summarize-on-close into the JSONL header).
- MCP OAuth flows for remote servers that need browser auth.
- Per-session worktrees for parallel sub-agents (git worktree per delegate
  task) so parallel builds never collide on files.

---

# Session 2 — 2026-09-06, v0.4.0 → v0.5.0

The "everything built" pass: features layered *on top* of the v0.4.0
architecture, plus the first non-terminal client (VS Code). The theme of
this session: **the loop doesn't change — you grow around it.**

## 7.1 Project instructions: CLAW.md (`src/agent.ts`)
- **What:** drop a `CLAW.md` (or `AGENTS.md`) in the workspace — or
  `~/.claw/CLAW.md` for global — and its content is appended to every
  system prompt, in every channel.
- **How:** `Agent.instructionsBlock(workspace)` reads the first candidate
  that exists, caps it at 8k chars, and labels it
  `PROJECT INSTRUCTIONS (from the workspace's CLAW.md — follow them)`.
  Deliberately *no cache*: reads are once-per-session and cheap, and a
  cache breaks "edit CLAW.md, start a new session".
- **Connects:** called from `Agent.systemPrompt`, so REPL, one-shot, serve,
  sub-agents, and SDLC phases all inherit it with zero extra wiring.

## 7.2 Custom slash commands (`src/commands.ts`) — new
- **What:** `.claw/commands/review.md` becomes REPL `/review $ARGUMENTS`.
  Workspace commands shadow `~/.claw/commands/`.
- **How:** `findCommand` → `renderCommand` (template expansion:
  `$ARGUMENTS`/`{args}` = the whole argument string, `$1..$9` = individual
  words). The REPL's slash dispatch tries the custom-command lookup in its
  `default:` branch and, on a hit, runs the expanded template as an
  ordinary turn — no new agent machinery. `/help` lists them with scope.
- **Connects:** this is the Claude Code custom-commands pattern; it makes
  the VS Code extension's code-lens ideas possible later (see below).

## 7.3 The web chat UI (`src/serve.ts`)
- **What:** `GET /` now returns a built-in chat page (zero deps: one inline
  HTML string, dark theme, session continuity, "new session" button);
  `/health` moved to `/health` only.
- **How:** the page's JS calls the *same* `POST /chat` endpoint with the
  session id, rendering `answer`, `tool_calls`, and usage. All user-visible
  text goes through `escapeHtml` — tool output can contain anything.
- **Connects:** proves the HTTP channel is a complete API. The VS Code
  extension is the same design with a different shell around it.

## 7.4 `--json` output (`src/cli.ts`)
- **What:** `claw -M --json "task"` and `claw run --json` print pure JSON:
  `{ session_id, answer, tool_calls, aborted, model, workspace, usage }`.
- **How:** `runOneShot` gets a `jsonOut` mode: trace and streaming sinks go
  silent, banner and cost line are skipped, one `console.log(JSON)` at the
  end. Anything that needs a *result* rather than an *experience* (CI,
  scripts, editor integrations) consumes this.
- **Connects:** one-shot mode was already the "no TTY, one turn" path;
  `--json` makes it a stable contract.

## 7.5 The VS Code extension (`vscode/`) — new
- **What:** a thin client, not a second agent. Commands: *Open Chat*,
  *Explain Selection* (selection + file/line context as a prompt), *Restart
  Server*. Settings: `claw.serverUrl` (attach) and `claw.cliPath` (auto-
  spawn `claw serve`).
- **How:** VS Code webviews can't `fetch()` localhost, so `extension.js`
  implements a ~30-line postMessage bridge (webview → extension host →
  HTTP). Session ids live in `workspaceState`, so the panel continues the
  same conversation the terminal and web UI could. Full design rationale
  and roadmap: [vscode/README.md](../vscode/README.md).
- **Connects:** third client of one channel (terminal → browser → editor).
  Rule of thumb it encodes: *if a feature doesn't fit over `/chat`, the
  feature belongs in the agent, not the client.*

## 7.6 Tests & docs
- Selfcheck: 54 assertions (instructions loading + AGENTS.md fallback,
  command discovery/expansion, web UI route, and a **real CLI spawn** for
  `--json` — `selfcheck` runs `node src/cli.ts -M --json "calc 7 * 6"` and
  parses the stdout).
- [GUIDE.md](GUIDE.md) — the complete learning guide: mental model, every
  module, the loop, guards, caches, sub-agents, routing, MCP, channels,
  memory, testing, plus a reading order and exercises.

---

# Session 3 — 2026-09-07, v0.5.0 → v0.6.0

The completion pass: an audit found five roadmap items that were promised
but not built. All five are now implemented, tested, and wired into every
channel. The recurring theme: **each feature is a small change to an
existing seam** — the per-turn `onText` override, the JSONL header, the
delegate parallel path, the MCP HTTP transport, the webview bridge.

## 8.1 Streaming `/chat` (SSE)
- **What:** `POST /chat` with `"stream": true` responds with
  `text/event-stream`: repeated `{"type":"text","delta":…}` frames as the
  model speaks, then one `{"type":"done", …}` frame carrying the exact
  payload of the non-streamed response. The web UI renders tokens live;
  the VS Code extension streams through its bridge.
- **How:** the key change was in `agent.ts` — `runTurn` now accepts a
  *turn-scoped* `onText` that overrides the agent-level sink for that turn
  only. Without it, two concurrent HTTP sessions streaming at once would
  interleave their deltas into each other's responses (the agent-level
  sink is shared; the session lock only serializes per session).
- **Verified:** selfcheck POSTs `stream:true`, parses the SSE frames, and
  asserts both the delta and the done event; live curl test shows the
  frames arriving.

## 8.2 Session summaries (summarize-on-close)
- **What:** on REPL exit, CLAW asks the model for a ≤250-word summary of
  the session and stores it in the JSONL header (`summary` field).
  `claw continue` / `/resume` re-inject it as a
  `[Summary of a previous session]` system message.
- **How:** `Agent.summarizeSession(provider, history)` — one no-tools
  call, skipped when history is short, returns null on provider failure
  (exiting the REPL must never hang on a flaky endpoint).
  `SessionStore.meta(id)` / `updateMeta(id, patch)` patch just the header
  line, preserving the append-only property of the message log.
- **Design note:** only the *header* is rewritten; messages remain
  append-only, so a crash still corrupts at most one line.

## 8.3 Git worktrees for parallel sub-agents
- **What:** `"subagents": { "worktree": true }` — each task in a parallel
  `delegate` fan-out works in its own `git worktree`
  (`.claw/worktrees/task-N…` on branch `claw/task-N…`), so parallel file
  edits never collide.
- **How:** `createWorktree`/`removeWorktree` helpers in `tools/git.ts`.
  The sub-agent's system prompt says it's on an isolated branch and should
  commit there; the receipt names the branch and path; branches are LEFT
  behind — merging is a human decision. Learned during testing: the `git()`
  helper *resolves* (doesn't reject) on nonzero exit, so `createWorktree`
  verifies the worktree directory actually materialized instead of
  trusting the command result — the duplicate-name selfcheck caught this.

## 8.4 MCP auth headers
- **What:** `"headers": { "Authorization": "Bearer ${MY_TOKEN}" }` on an
  http MCP server (also `claw mcp add … --header "Name: ${ENV_VAR}"`).
  `${VAR}` references expand from the environment at request time —
  secrets stay out of config files.
- **Verified:** the HTTP fixture server now *requires*
  `Authorization: Bearer secret-token-123` (401 otherwise), proving the
  expansion and delivery on every request.

## 8.5 VS Code extension: streaming + code lens
- **What:** the chat panel now renders tokens live (the extension host
  consumes the same SSE stream and forwards `delta` messages); a
  `Claw: Fix this` code lens appears on every editor diagnostic and sends
  file, line, severity, message, and the code snippet to `/chat`, where the
  agent (already owning `read_file`/`edit_file`) does the fix.
- **Design rule it demonstrates:** the extension never *applies* the fix
  itself — it forwards context and lets the agent use its tools, keeping
  one guard stack and one audit trail.

## 8.6 Status after session 3

Every item from every roadmap so far is implemented and tested: 58
selfchecks.

---

# Session 4 — 2026-09-07, v0.6.0 → v0.7.0

Closing the last deferred item: **full MCP OAuth** (Authorization Code +
PKCE), plus the production documentation set.

## 9.1 `src/oauth.ts` — OAuth 2.0 from scratch
- **What:** the complete browser-based flow for remote MCP servers:
  well-known discovery (protected-resource → authorization-server metadata,
  with a configured `authServer` shortcut), dynamic client registration
  (RFC 7591), PKCE S256 (RFC 7636), a one-shot local callback HTTP server,
  token exchange, persistent storage in `~/.claw/mcp-tokens.json`, and
  refresh via the refresh_token grant.
- **Why buildable offline:** the browser step is injectable
  (`setOpenBrowserHook`). The selfcheck runs a fake authorization server —
  metadata, /register, /authorize (302), /token — that *enforces PKCE*
  (it hashes the received verifier and compares to the challenge it issued),
  and the hook plays the browser by following the 302 to claw's callback.
  Every step of the real flow is exercised without a real identity provider.
- **Debug stories:** (1) the fixture initially responded 401 without
  consuming the request body, which poisoned the undici keep-alive
  connection — the retried request came back as a bogus 404; always drain
  the body first. (2) `McpClient.close()` fired a fire-and-forget
  `notifications/exit` POST over HTTP, outliving the server and tripping a
  libuv assertion on process exit — over http there is no process to exit,
  so close() now sends nothing. (3) the selfcheck's `withServer` helper
  appends `/v1` to bases (OpenAI-style), so OAuth well-known paths missed —
  the test now strips the suffix.

## 9.2 Client integration + CLI
- `McpClient`: a stored/refreshed token is attached proactively before the
  first request; a 401 triggers `mcpOAuthLogin` **once** and retries the
  request; explicit `headers.authorization` always wins over the token.
- CLI: `claw mcp login <name>` / `claw mcp logout <name>`;
  `claw mcp add --oauth [--auth-server <url>] [--scopes a,b]`;
  `claw doctor` now checks git availability (the git tools depend on it).

## 9.3 Documentation set
- [GUIDE.md](GUIDE.md) — updated (OAuth section, 60 checks, reading order,
  new exercises).
- [DEPLOY.md](DEPLOY.md) — **new**: deployment shapes, systemd/Docker units
  with OS-level confinement, TLS+auth proxies (SSE-aware), the scaling
  ladder (affinity → shared session store → stateless), cost governance
  via budgets and iteration caps, observability, and a hardening checklist.
- README — OAuth usage, login/logout commands, roadmap refreshed.

## 9.4 Status after session 4

60 selfchecks, zero deferred roadmap items. Remaining ideas are growth
options, not gaps: token-store backends (keychain/encrypted), web UI
markdown rendering, worktree auto-merge, more channel adapters.

---

# Session 5 — 2026-09-07, v0.7.0 → v0.8.0

"Keep building": live observability in every channel plus spend governance,
all through existing seams.

## 10.1 Tool-trace events everywhere
- **What:** the ACT phase now emits `tool-start` / `tool-end` events (name,
  args/result preview, ok flag) through a turn-scoped `onEvent` sink — the
  same pattern as the turn-scoped `onText` from session 3. `claw serve`'s
  SSE stream forwards them as `{"type":"tool",…}` frames; the web UI and
  the VS Code panel render them as live `▶ tool …` / `◀ result` trace
  lines. Result: every channel shows what the agent is DOING, not just
  what it says.
- **Implementation gotcha:** the web UI lives inside a TypeScript template
  literal, so the markdown renderer cannot contain a literal backtick
  (it would terminate the template). `md()` builds its fence pattern with
  `String.fromCharCode(96)` instead.

## 10.2 Token budgets (the third runaway guard)
- **What:** `AgentOpts.budget: { maxInputTokens?, maxOutputTokens? }` — the
  loop checks its own ledger **before each iteration** and stops with
  `[budget exceeded: input 120/100 tokens — stopping to protect the spend]`.
  Wired to sub-agents via `"subagents": { "budget": … }`, so one delegated
  task can't burn the session's allowance.
- **Design note:** the check is deliberately pre-iteration (not
  post-usage). A model that already produced its final answer finishes
  normally; only *continuing* work is cut off. The selfcheck documents the
  exact boundary: with 60 input tokens per call, a budget of 50 trips
  before the second call; a budget of 100 does not.

## 10.3 `--dry-run`
- **What:** `claw --dry-run "refactor X"` never executes risky tools. The
  approval guard denies them with the exact would-be args
  (`dry-run: shell was NOT executed. It would have run with args …`),
  feeding the intent back to the model — which keeps planning read-only.
  Safe/read tools are untouched.
- **Use:** CI previews ("what would the agent have run?"), and auditing an
  agent's plan before letting it loose.

## 10.4 `claw init --example`
- **What:** writes a full-featured `.claw.json`: a model alias with
  failover + a budgeted paid backend, sub-agent options, an MCP server,
  tuned allowlists — every feature in one valid file.

## 10.5 Status after session 5

64 selfchecks. The web UI also gained light markdown rendering (fenced
code blocks and inline code, everything HTML-escaped first). Remaining
growth options: token-store backends, worktree auto-merge, more channel
adapters, a Redis session store.

---

# Session 6 — 2026-09-07, v0.8.0 → v0.9.0

The harness-research pass: benchmarked CLAW against Claude Code, Codex
CLI, Devin, and Pi (pi.dev — the "phi" in the request), self-evaluated the
gaps, and adopted the four best missing features. Full matrix, adoption
rationale, and the rejected list: [RESEARCH.md](RESEARCH.md).

## 11.1 Permission modes (← Claude Code + Codex)
`--permission-mode plan | default | acceptEdits | bypass`, live-switchable
in the REPL with `/mode`. `plan` denies every mutating tool with
"present your complete plan as text" (read-only tools run — the explore-
then-plan workflow); `acceptEdits` auto-runs `write_file`/`edit_file`/
`mkdir` but keeps the human for shell/git_commit; `bypass` ≡ `--yolo`.
~20 lines inside `approvalGuard` because the gate was already the single
choke point.

## 11.2 User hooks (← Claude Code)
`"hooks": { "beforeTool", "afterTool", "onTurnEnd" }` — shell commands
receiving the call as JSON on stdin. `beforeTool` exit 2 vetoes with the
stderr as the reason the model sees; every other failure is non-blocking.
`userHooksGuard` rides the existing guard hook points, so hooks apply in
every channel including sub-agents.

## 11.3 todo_write (← Claude Code TodoWrite / Devin plan file)
One tool, in-memory full-replace list, rendered checklist returned into
the context each write. Disproportionately valuable for long runs.

## 11.4 Background shell (← Claude Code BashOutput)
`shell { background: true }` → task id; `task_output { task_id, wait_ms }`
polls; `task_kill` terminates. Dev servers and long builds no longer hit
the 30s timeout or block the loop. Windows lesson repeated from earlier
sessions: cmd.exe /s mangles embedded quotes, so long-lived commands (and
hook scripts in tests) run from temp script files, not `node -e`.

## 11.5 Rejected, documented
Browser tool, OS-level sandbox, checkpoint/rewind, vision input, and Pi's
extension API — each with its reason, in RESEARCH.md §4.

## 11.6 Status after session 6

68 selfchecks. CLAW now has parity on every feature of Claude Code and
Codex CLI that matters in a terminal harness, plus several neither has
(parallel sub-agents with worktrees and budgets, router budgets, MCP
OAuth, an HTTP channel with a web UI).

---

# Session 7 — 2026-09-07, documentation

**[HARNESS-ARCHITECTURES.md](HARNESS-ARCHITECTURES.md)** — an in-depth
architecture study of Claude Code (master loop, steering, ~92% compaction,
tools, subagent summary-back), Codex CLI (Rust core; Seatbelt/Landlock/
Windows sandboxes under a separate approval policy), Pi (layered packages,
~4 tools, no permission system, OS-delegated containment, supply-chain
hardening), and Devin (cloud VM, editable plan files, playbooks) — plus
SWE-agent, OpenHands, Aider, and Cline, the cross-cutting patterns, and a
mapping of each pattern to CLAW's implementation. Sources are the
projects' own docs/repos plus the strongest reverse-engineering writeups.

---

# Session 8 — 2026-09-07, v0.9.0 → v1.0.0

The UI milestone. Research found the **DeepSeek Harness (`dsh`)**: a
plugin-based runtime whose defining idea is that *everything is a
projection of one append-only event stream* — resume, fork, replay, audit,
AND the beautiful web UI all derive from the same log — served locally via
`dsh web`. Devin's **Fusion** mode showed the same direction: agent work
presented visually, not just as terminal text. CLAW already had the event
stream (JSONL sessions, SSE `onEvent` traces); this session built the
projection it deserved.

## 12.1 The web workbench (`web/index.html`) — new
A zero-dependency local web app served at `GET /` (the TUI stays for the
terminal, as requested the web app is the flagship for design):
- **Sessions sidebar** — every past conversation, one click away.
- **Streaming markdown chat** — tokens live, mini-renderer with fences,
  lists, bold, links; typing indicator; sticky-scroll that yields when you
  scroll up.
- **The tool-trace timeline** — every tool call is a card that animates
  `▶ running` → `✓ 42ms` / `✗`, with args/result expanded on click. Fed by
  the SSE `tool` events; `tool-end` now carries `ms` (measured in the ACT
  loop).
- **Live token meter** — accumulates usage from every `done` frame.
- Still one editable HTML file, no framework, no CDN — refresh to customize.

## 12.2 Event-stream endpoints
- `GET /sessions` — the sidebar's list (top 50).
- `GET /history?session_id=…` — full conversation replay (memory-backed or
  JSONL-backed), the dsh-style replay projection.

## 12.3 Status after session 8

69 selfchecks. The harness now has: the guard stack, permission
modes, hooks, parallel sub-agents with worktrees/budgets, git tools,
MCP with sampling + OAuth, routing with budgets, LLM compaction, session
summaries, three channels (terminal / HTTP / web workbench), a VS Code
client, and a research-backed architecture — every core idea from Claude
Code, Codex, Pi, Devin, and DeepSeek Harness represented in one
zero-dependency codebase.

---

# Session 9 — 2026-09-07, v1.0.0 → v1.1.0

The workbench redesign, run through the frontend design pipeline
(design-intelligence tokens: productivity profile, 150ms ease-out, minimal
motion). The first web app was a chat page; the user was right to reject
it. v1.1.0 is an IDE:

- **Apple-clean token adaptation**: near-black neutral surfaces (#0b0b0d /
  #131316), hairline borders (rgba(255,255,255,.08)), SF system font,
  one restrained green accent for status only, 150ms ease-out motion.
  slop_audit: PASS (0 errors) after banning em-dashes and transition-all.
- **IDE layout**: title bar (brand, session dropdown, permission-mode
  segmented control, token meter), activity rail + contextual panels
  (files explorer, skills, MCP servers, settings), collapsible console
  pane with Timeline / Raw-events tabs, status bar.
- **New endpoints**: `GET /status`, `GET /files` (confined browsing),
  `POST /upload` (attachments into `attachments/`, 10 MB cap, path
  sanitized), `POST /mode` (live permission-mode switching via the shared
  approveState), `GET /skills`, `GET /settings`.
- **Composer upgrades**: `@`-mention autocomplete over the live file tree,
  `/` command insertion, paperclip attachments, inverted-white send button.
- The redesign is still one zero-dependency HTML file, and still a pure
  projection of the event stream.

---

# Session 10 — 2026-09-07, v1.1.0 → v1.2.0

"Stop mocking me": the workbench must be a real product. Three additions,
all driven by user feedback.

## 13.1 Real onboarding (OpenCode-style)
- `GET /setup` serves provider presets (OpenAI, Anthropic, OpenRouter,
  Ollama — local and keyless — and custom OpenAI-compatible); `POST /setup`
  validates, persists to the layered config (`updateUserConfig`, falling
  through to `updateProjectConfig` when a project `.claw.json` outranks
  the user file — a real layering bug the e2e test caught), chmods the
  config to 600, **rebuilds the provider and swaps it live** via
  `agent.swapProvider`, and flips `configured` without a restart.
- Unconfigured servers answer `/chat` with `428 setup_required`; the
  workbench opens the Connect-a-model screen automatically. The mock now
  only appears when explicitly requested (`-M`).

## 13.2 Session titles
- The first message of a session becomes its title (`updateMeta`), carried
  through `/sessions` and displayed in the title bar, the session menu,
  and the sessions panel — ids are for machines, titles for people.

## 13.3 Config hygiene
- `CLAW_HOME` env override isolates all state (config, sessions, tokens),
  which makes the setup flow fully testable and multi-install friendly.
- Layering correctness verified live: user config → project config
  fall-through, provider swap, `configured` flag, and title derivation all
  covered by selfchecks (70 total).

---

# Session 11 — 2026-09-07, v1.2.0 → v1.3.0

Two structural fixes from user testing: the first rail button was a broken
no-op (it referenced `navChat`, an element that no longer existed), and
there was no way to change the project/workspace.

## 14.1 The world container + live workspace switching
- cli.ts now builds the world through a **`buildWorld(workspace)` factory**
  (tools, guards, approval state, agent — everything workspace-bound),
  called once at startup and again on every switch.
- serve.ts works against a mutable **`ServeWorld`** container; every
  endpoint reads it fresh, so a swap takes effect on the next request.
- New endpoints: `POST /workspace { path }` (validates the directory,
  delegates to the CLI-provided `swapWorkspace`, clears in-memory session
  state, records the choice), `GET /fs?path=` (machine-wide directory
  browser for the picker — a local operator tool), `GET /workspaces`
  (current + recents, persisted to `~/.claw/workspaces.json`).
- Switching rebuilds confinement at the new root — the path-confine guard,
  fs tools, and system prompt are all regenerated, never reused.

## 14.2 The rail, fixed properly
- The first icon is **Sessions** — a real panel like Files/Skills/MCP/
  Settings, with working toggle (click to open, click again to close),
  correct active-state highlighting, and drawer behavior on narrow
  windows. The dead `navChat` reference is gone.
- The **status-bar workspace path is clickable**: it opens a switcher with
  recent workspaces, a full filesystem browser (descend into folders),
  and a manual path field. Switching resets the transcript to a fresh
  session in the new workspace; sessions on disk are kept.

## 14.3 Status after session 11

71 selfchecks. v1.3.0.

---

# Session 12 — 2026-09-07, v1.3.0 → v1.4.0

The dsh-gap closer: research into the DeepSeek Harness web UI surfaced its
three signature capabilities — the **Trajectory view** (replay any run step
by step from the append-only log), **inline reasoning traces**, and
**search across sessions**. CLAW already had the append-only log; this
session built the missing projections.

## 15.1 Reasoning traces
- `openai.ts` parses `delta.reasoning_content` (and `reasoning`) — the
  DeepSeek R1 / OpenRouter thinking-model wire format — and streams it
  through a new `onReasoning` sink threaded provider → agent → serve.
- The workbench renders it as a collapsible **Thinking** panel above the
  answer: open (streaming) while the model thinks, auto-collapsed when
  text starts. Persisted as an event record, so replays show it too.

## 15.2 The trajectory (dsh's core idea, completed)
- Tool events and reasoning are now **written into the session log** as
  `{ type: "event", … }` records (`store.appendRaw`) — the log is the
  single artifact, and the UI is a pure projection of it.
- `/history` returns the full ordered record list; opening a session
  replays messages, tool cards, AND thinking blocks exactly as they
  happened.

## 15.3 Search across sessions
- `GET /search?q=` scans every session's title + full log text and returns
  matches with snippets. The sessions panel has a search box (debounced) —
  find any past run by content, not just by title.

## 15.4 Status after session 12

72 selfchecks. v1.4.0.
