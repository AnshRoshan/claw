# CLAW — The Complete "How It's Built" Guide

*Learn how every piece of an agentic coding harness works by reading the one
you own.* This guide teaches CLAW from zero: the mental model, every module,
how they connect, and why each design choice was made. Every section points
at real files and functions in `src/` so you can read along.

> Companion docs: [BUILD.md](BUILD.md) is the chronological build log (what
> was built, in what order, and how it connects); [DEPLOY.md](DEPLOY.md) is
> the production guide (deployment, security, scaling), and
> [HARNESS-ARCHITECTURES.md](HARNESS-ARCHITECTURES.md) surveys how Claude
> Code, Codex, Pi, and Devin work inside. This file is the *textbook*; the
> others are the *lab notebook*, *ops manual*, and *field survey*. The course mapping — how each
> concept corresponds to Code with Antonio's *Build Your Own Claude Code*
> ([repo](https://github.com/code-with-antonio/nightcode)) — lives in
> BUILD.md §3.

**Table of contents**

1. [The mental model](#1-the-mental-model) — what an agent actually is
2. [The vocabulary](#2-the-vocabulary) — `types.ts`, the four interfaces
3. [Configuration](#3-configuration) — layered config, `config.ts`
4. [Providers](#4-providers) — talking to LLMs, `providers/*`
5. [Tools](#5-tools) — the agent's hands, `tools/*`
6. [The loop](#6-the-loop) — `agent.ts`, the heart of everything
7. [Guards](#7-guards) — the security spine, `guards.ts`
8. [Caches](#8-caches) — three levels of not paying twice
9. [Sub-agents](#9-sub-agents) — agent-to-agent delegation, `subagent.ts`
10. [Routing](#10-routing) — many backends, one provider, `providers/router.ts`
11. [MCP](#11-mcp) — the tool plug-in protocol, `mcp.ts`
12. [Channels](#12-channels) — REPL, HTTP, web UI, `repl.ts` / `serve.ts`
13. [Memory](#13-memory) — sessions, history, compaction
14. [Higher workflows](#14-higher-workflows) — `sdlc.ts`, `doc`, commands
15. [Testing](#15-testing) — the selfcheck philosophy
16. [Reading order & exercises](#16-reading-order--exercises)

---

## 1. The mental model

Strip away everything and an AI coding agent is this:

```
loop:
  1. send the conversation + tool list to a model
  2. the model answers with EITHER text (→ done) OR tool calls
  3. if tool calls: decide if they're allowed → run them → append the
     results to the conversation as messages → go to 1
```

That's it. Claude Code, NightCode, OpenCode, and CLAW are all variations on
these five lines. Everything else — streaming, guards, caches, sessions,
sub-agents, MCP — exists to make one of five steps *better*:

| Step | What makes it hard | CLAW's answer |
| --- | --- | --- |
| 1. send | formats differ per vendor | Provider adapters + one canonical internal shape |
| 2. answer | huge histories blow the context window | compaction (§13) |
| 3a. allow | the model can do real damage | the guard stack (§7) |
| 3b. run | tools need a sandbox-ish boundary | workspace confinement (§5) |
| loop | a dumb model repeats a failing call forever | iteration cap + loop-detect (§6, §7) |

**The one sentence to remember:** *the model never touches your machine —
it emits structured requests, and harness code decides what actually
happens.* Every security and reliability property of an agent follows from
taking that sentence seriously.

## 2. The vocabulary

Read `src/types.ts` first — it's ~140 lines and defines the entire shared
vocabulary. Four interfaces matter:

**`ChatMsg`** — one message, in *OpenAI wire format*. CLAW deliberately
picks one vendor's format as the canonical internal shape:

```ts
{ role: "system" | "user" | "assistant" | "tool",
  content: string,
  tool_calls?: ToolCall[],   // assistant asks for tools
  tool_call_id?: string }    // tool answers one call
```

Why one shape? Because then every provider adapter is a pure *translator*
(Anthropic's `content_block_delta` events → `ChatMsg`), and the loop code
never branches on vendor. This is the same trick the orchestrator and
NightCode's shared `packages/shared` play.

**`Tool`** — one thing the agent can *do*:

```ts
{ name, description, parameters,  // JSON-schema sent to the model
  risk: "safe" | "read" | "risky",  // its security posture, declared up front
  cacheable: boolean,             // may its result be memoized?
  execute(args) → Promise<string> }
```

Two fields deserve attention. `risk` is a *declaration*, not enforcement —
guards (§7) consume it. `cacheable` encodes physics: `read_file` with the
same args returns the same bytes (cache it); `shell` just mutated the world
(never cache it).

**`Provider`** — the model, abstracted:

```ts
{ name, model, streamable: boolean,
  chat(messages, toolDefs, { onText?, signal? }) → { content, toolCalls, usage } }
```

`onText` is the streaming sink; `signal` is the AbortSignal that makes
cancellation work everywhere (a sub-agent timeout aborts an in-flight HTTP
request mid-stream — this only works because every layer passes the signal
down).

**`Guard`** — a hook: `point` (one of 7 named places in the loop) + `check`
returning a verdict: `continue | deny | modify | abort | respond`. Five
verbs is enough to express every security policy in the codebase.

## 3. Configuration

**File: `src/config.ts`.** Five layers, lowest priority first:

```
defaults → CLAW_* env vars → ~/.claw/config.json → ./.claw.json → CLI flags
```

The implementation is one `pick(key, envVal)` function that walks the layers
in order; layers merge *shallowly per key*, so a project `.claw.json`
containing only `{"model": "x"}` keeps your user-level `baseURL`. Two
exceptions merge *deeply* (map-merge): `mcpServers` and `models` — because
the natural use is "user config has my servers, project config adds its
own", and shallow merge would drop one side.

Key design choice: **`apiKey` is "the name of an env var, OR a literal
key"**. `resolveApiKey()` checks `process.env` first; if the value names an
unset variable, it returns `undefined` — and `undefined` is what flips CLAW
to the offline mock. That single decision is why the demo "just works" with
zero setup while never risking a key being committed: configs contain
*names*, not secrets.

## 4. Providers

**Files: `src/providers/openai.ts`, `anthropic.ts`, `mock.ts`, `factory.ts`.**

Each real provider is ~150 lines doing exactly two things:

1. **Translate out**: `ChatMsg[]` + `ToolDef[]` → vendor wire format
   (OpenAI: `messages` + `tools`; Anthropic: system pulled out of the
   message list, `tool_use`/`tool_result` content blocks).
2. **Translate in + stream**: parse the vendor's Server-Sent-Events stream
   byte-by-byte with `sseEvents()` (`src/util.ts`) — accumulate
   `delta.content` into text, accumulate tool-call fragments by index (LLMs
   stream tool arguments as JSON chunks!), count usage.

The Anthropic adapter is worth reading closely: Anthropic streams
*content blocks* (`text`, `tool_use`), and a `tool_use` block's JSON input
arrives across many `input_json_delta` events. The adapter buffers partial
JSON per block index and parses at block-stop. Get this wrong and you'll
"lose" tool calls that the model clearly made — a classic agent bug.

**`mock.ts`** deserves respect, not pity: it pattern-matches the user text
and emits *exactly the same shapes a real model would* — tool calls, then a
final answer after observing results. Consequences:

- The whole loop, guards, rendering, and persistence run identically offline.
- Every selfcheck that needs "a model" uses scripts with the same discipline.
- The mock is also the *fallback provider*: no API key → mock, never a crash.

**`factory.ts`** turns config into providers: a plain model name → one
backend; a `models.<alias>` with N backends → a `RouterProvider` (§10);
`keys: [A, B]` on one backend → two failover variants (key rotation). The
mock-fallback decision (`anyKeyConfigured`) also lives here so the CLI, the
REPL's `/model`, and `claw models` all agree on what "has a key" means.

## 5. Tools

**Files: `src/tools/*.ts`.** Each maker function returns `Tool` objects;
`cli.ts` composes the list. Patterns to internalize:

**Confinement is defense-in-depth.** Every file tool resolves paths through
`confine(root, p)` (`util.ts`): resolve → take `path.relative(root, abs)` →
reject if it starts with `..` or is absolute. The *guard stack* also checks
(`pathConfineGuard`), but the tool checks *again* — guards protect against
the model, `confine()` protects against guards having a bad day.

**Risk is declared, not inferred.** `write_file` is `risk: "safe"`
(agents must write files to be useful — approval-gating it would ruin the
experience), `read_file` is `read`, `shell` and `git_commit` are `risky`.
The approval gate (§7) only asks for tools the operator listed as risky in
config — so *users* set policy, tools just declare.

**Spawn argvs, not shells.** `shell.ts` must use a shell (that's its job)
so it's risky and allowlisted. But `git.ts` spawns `["git", "commit", "-m",
msg]` directly — an argv array cannot be chained into `; rm -rf` the way a
shell string can. Rule: *shell interpolation is the vulnerability; argv
arrays are the fix.*

**The task list writes the plan into the model's own context** —
`todo_write` (from `tools/todo.ts`) is a one-tool version of Claude Code's
TodoWrite and Devin's plan file: full-replace semantics, statuses
(`pending/in_progress/completed`), and every write returns the rendered
checklist so the plan never leaves the conversation.

**Long work detaches.** `shell { background: true }` returns a task id;
`task_output` polls it (optionally waiting) and `task_kill` terminates it.
A dev server can't block the loop or hit the 30s timeout.

**Output discipline.** Every tool result goes back INTO the model's context
window, so tools cap themselves (`MAX_READ`, `MAX_OUTPUT`) *and* the
output-cap guard truncates again — belt and suspenders, because a single
10-MB `read_file` silently ruins a session.

**Arg parsing tolerates the model.** `parseJsonArgs` (`util.ts`) tries
`JSON.parse`, then falls back to slicing the first balanced `{...}` out of
prose or ```json fences — because real models wrap tool arguments in noise
constantly.

## 6. The loop

**File: `src/agent.ts`** — the most important ~350 lines in the repo.

```ts
async runTurn(sessionKey, history) → { answer, history, usage, toolCallsMade, aborted }
```

Read it in this order:

1. **The session lock** (lines around `this.active`): a `Set<string>` of
   keys currently mid-turn. Same key again → immediate refusal. This is
   what makes concurrent HTTP requests or double-Enter safe: *one turn per
   conversation at a time*, released in a `finally` (locks that leak on
   exceptions are worse than no locks).
2. **Response cache**: hash the whole history; exact repeat → replay the
   cached answer, zero LLM calls.
3. **The iteration loop** (`for i in 1..maxIterations`):
   - *beforeLLM* hook → `maybeCompact()` (§13) → `provider.chat(...)`.
   - Push the assistant message (with `tool_calls` if any) into history.
   - *afterLLM* hook (loop-detect lives here).
   - **No tool calls = the only happy exit.** The model is done; run
     *onTurnEnd* (final secret-scan) and return.
   - Otherwise **ACT**: for each tool call, sequentially — one at a time,
     exactly like the orchestrator. Sequentiality is a feature: each
     observation is visible to the next call, and failures are attributable.
   - Each call flows through the guard pipeline (§7) and becomes a `tool`
     message with `tool_call_id` matching the call — *that matching is the
     OpenAI protocol's conversation threading; get it wrong and vendors
     reject the request.*
4. **Budget runaway guard**: with `AgentOpts.budget`, the loop checks the
   ledger *before each iteration* and stops with `[budget exceeded: …]` —
   the guard that bounds spend in production (DEPLOY.md §4.3).
5. **Iteration cap**: exhausted without a final answer → stop with an
   explicit "[reached N iterations…]" message. This, loop-detect, and the
   budget are the three runaway guards; agents that hang cost money forever.

Also in the ACT phase: every tool execution emits a **trace event**
(`tool-start` / `tool-end` with an args/result preview) through a
turn-scoped `onEvent` sink — the same pattern as `onText`. That's how the
web UI and the VS Code panel show `▶ shell …` / `◀ …` lines live without
knowing anything about the loop's internals.

Also note `swapProvider()` — the REPL's `/model` swaps providers mid-session
and history survives, because history is vendor-neutral `ChatMsg`s. That's
the canonical-shape decision (§2) paying off.

## 7. Guards

**File: `src/guards.ts`.** Seven hook points, cheapest-first:

| # | Hook point | Guard | Cost |
| --- | --- | --- | --- |
| 1 | onTurnStart | rate-limit (30 turns/min) | arithmetic |
| 2 | afterLLM | loop-detect (same call 3×→ abort) | map lookup |
| 3 | beforeTool | path-confine | path math |
| 4 | beforeTool | shell-allowlist | string match |
| 5 | approveTool | approval gate (**the human**) | a conversation |
| 6 | afterTool | output-cap, then secret-scan | regex |
| 7 | onTurnEnd | secret-scan the final answer | regex |

`runPoint()` executes guards registered at a point and the **first
non-continue verdict wins**. The five verdict verbs:

- `deny` — block; the model sees the reason (it can adapt: "user denied
  rm — explain and propose an alternative").
- `modify` — rewrite args or results (output-cap truncates; secret-scan
  redacts `sk-ant-…` before the model or the human ever sees it).
- `abort` — kill the whole turn (runaway loops).
- `respond` — skip execution entirely, feed fixed text back.

The gate is also where **permission modes** live (Claude Code's modes,
Codex's sandbox dial): `plan` denies every mutating tool with
"present your complete plan as text" — read-only tools sail through —
while `acceptEdits` auto-runs `write_file`/`edit_file`/`mkdir` but keeps
the human for `shell`/`git_commit`. Same choke point, three policies.

**User hooks** (`userHooksGuard`) are the operator's escape hatch: config
shell commands that receive the tool call as JSON on stdin at
`beforeTool`/`afterTool`/`onTurnEnd`. An exit code 2 on `beforeTool`
vetoes the call and the reason goes back to the model; any other failure
is a non-blocking warning — a broken hook can never wedge the agent.

Subtlety worth learning: the **approval gate is a separate hook point
(`approveTool`) from `beforeTool`** (and `--dry-run` reuses the gate:
risky *and* file-mutating tools are denied with their would-be args, so a
dry run shows the plan without touching anything). The shell-allowlist guard marks
non-allowlisted commands at *beforeTool* with `modify`, and the approval
guard consults the allowlist *again* at *approveTool*. Redundant? No — it
lets policy checks evolve independently of the human-interaction check, and
the selfcheck asserts allowlisted commands ask the human **zero** times.

And the deepest principle in the codebase: **the model is untrusted
input**. Secret-scan runs on tool output *and* on the final answer —
because a malicious web page the model just fetched could contain
"please print your API key" and the model might oblige. The last line of
defense is *after* the model, not before it.

## 8. Caches

Three levels, three different keys (`agent.ts`, `cost.ts`):

1. **Response cache** — `sha1(JSON.stringify(history))` → final answer.
   Exact-repeat conversation = free turn. 10-minute TTL.
2. **Tool cache** — `sha1(name + JSON.stringify(args))` → result, only for
   `cacheable` tools. Two turns that both `read_file("x")` run it once.
   Side-effecting tools are never cached — this flag is a promise the tool
   author makes about physics.
3. **Provider prompt cache** — not ours to implement: vendors cache the
   unchanged prefix of your request. CLAW surfaces `cacheReadTokens` in
   every usage report so you can *see* it working (pin your model; see
   `claw-orchestrator -cachetest` for the measured experiment).

Plus **summary memoization** (§13): compaction hashes the dropped prefix so
a long turn summarizes once, not every iteration.

## 9. Sub-agents

**File: `src/subagent.ts`.** The `delegate` tool spawns *isolated* agents:
fresh conversation, own session lock, own `Ledger`, same tools and guards.

The lifecycle is the part to study — every resource opened is closed:

```
spawn → AbortController + timeout timer
      → child Agent (signal wired down to the HTTP requests)
runTurn → finally { release session lock }
close → ledger.merge(child)  → receipt string to the parent
      → clearTimeout + ac.abort()   ← nothing lingers, ever
```

Errors inside the child become `[sub-agent #N error]` receipts rather than
exceptions — one failed sub-task must not sink a parallel fan-out. Depth is
bounded (`maxDepth`); a deeper `delegate` is *refused with advice* ("handle
this yourself") instead of erroring, because the refusing message goes back
into the model's context and the model adapts. Each child can also carry a
token **budget** (`subagents.budget`) — its loop stops with an explicit
message before crossing it, so one delegated task can't burn the session's
whole allowance.

**Parallel fan-out**: `delegate { tasks: [...] }` runs a fixed pool of
`maxConcurrency` async workers. The worker loop is the classic bounded
concurrency pattern — each worker `shift()`s a task and **awaits it before
taking the next**. (The first draft forgot the await; the selfcheck counts
in-flight executions and caught the breach immediately. Tests that measure
behavior, not just outputs, pay rent.)

## 10. Routing

**File: `src/providers/router.ts`.** One `RouterProvider` fronts N backends
and *is* a `Provider` — the loop can't tell. Strategies:

- **failover** — config order, skipping backends that failed within a 30s
  circuit-breaker cooldown. Multi-key backends become chained variants, so
  401/429 rotates keys automatically.
- **roundrobin / weighted** — spread load.

Pick order is computed as a *stable tiered sort*: healthy-before-cooling,
fresh-before-**spent**. A backend with a `budget` (maxCalls / maxTokens /
maxUsd) accrues usage from every successful `ProviderResult` (USD via the
same price table as the ledger) and, once spent, sinks to the end of the
order — cheap backends drain before paid ones are touched. If *everything*
is spent, calls still go through: availability beats frugality as a last
resort.

Design lesson: the router never caches, never retries internally, never
hides which backend answered — `statuses[]` + `report()` surface everything
to `/backends`. Observability is a feature, not a debug mode.

## 11. MCP

**File: `src/mcp.ts`.** The Model Context Protocol turns "any tool server"
into "CLAW tools". Two transports, one class:

- **stdio** — spawn the server, newline-delimited JSON-RPC over stdin/stdout.
- **streamable HTTP** — POST JSON-RPC to a URL; responses come back as
  either `application/json` or an SSE stream you scan for your request id.

The client is a mini JSON-RPC multiplexer: `pending` maps request ids to
resolvers; server→client messages are either responses (resolve), `ping`
(answer), **`sampling/createMessage`** (answer via the sampling handler —
the server can call *CLAW's* model, flattened to one prompt, tools
disabled), or an unsupported request (polite `-32601`, never a hang).

Mapped tools are named `mcp_<server>_<tool>` and security-classified:
trusted server → `safe`; name smells read-only (regex) → `read`;
everything else → `risky` (human gate). The classification regex is crude
and that's *fine and documented* — the default is the dangerous side.

**OAuth** (`src/oauth.ts`) — the newest and largest MCP piece: a complete
Authorization Code + PKCE client in ~300 dependency-free lines. The
sequence: well-known discovery (protected-resource → authorization-server
metadata, or a configured `authServer`) → dynamic client registration
(RFC 7591) → PKCE verifier/challenge (RFC 7636, S256) → a one-shot local
HTTP callback server → browser → code-for-token exchange → tokens persisted
to `~/.claw/mcp-tokens.json`. Expired tokens refresh via the refresh grant;
a 401 mid-session triggers login once and retries the request. Two design
choices worth internalizing: the *browser step is injectable*
(`setOpenBrowserHook`) so the whole flow is testable offline — the
selfcheck runs a fake authorization server that genuinely enforces PKCE —
and `${VAR}` header values expand from the environment so secrets never sit
in config files.

## 12. Channels

The `Channel` idea — where input comes from — is demonstrated three times
over one loop:

- **`repl.ts`** — readline with history, slash commands, per-turn `Screen`
  rendering (`render.ts`), `/model` swapping providers live.
- **`serve.ts` HTTP** — `POST /chat {message, session_id?}`: sessions live
  in a Map + JSONL; the session lock turns racing requests into a clean
  refusal; no TTY means the approval gate *denies* risky tools by default
  (policy, not accident).
- **The web workbench** (`web/index.html`, served at `GET /`) — the
  flagship surface: sessions sidebar, streaming markdown chat, a tool-trace
  timeline (collapsible cards with durations, fed by the `onEvent` stream),
  and a live token meter. It ships no JavaScript framework and no CDN —
  the whole app is one editable HTML file. DeepSeek Harness's insight
  applies directly: the UI is just a **projection of the event stream**
  (`/sessions`, `/history`, SSE `/chat`), so any rendering can be swapped
  without touching the agent.

**One agent, many channels** works because sessions are keyed
(`terminal:<id>`, `http:<id>`, `oneshot:<id>`, `sub:<parent>:<n>`) and the
lock is per-key. This is the architecture docs' "many chats, one loop".
Streaming safety across channels comes from a subtle detail: `runTurn`
accepts a **turn-scoped `onText`** that overrides the shared agent-level
sink — concurrent streamed sessions never interleave.

## 13. Memory

**Sessions** (`sessions.ts`): append-only JSONL per session — first line is
metadata, then one message per line. Append-only means a crash mid-write
corrupts at most one line (skipped on load, note `try/catch` in `load`).
`claw continue` re-reads the latest file; `/resume <id>` any other.
On REPL exit the session is **summarized** (`Agent.summarizeSession` —
best-effort, null on provider failure) into the JSONL header via
`SessionStore.updateMeta`; resuming re-injects it as a system message, so
a long session re-orients instantly.

**Context economy** — the part every agent gets wrong eventually. History
only grows, the context window doesn't, so:

- `compactAt` triggers **LLM compaction**: split history into
  `[system] + droppable + recent window`, send the droppable transcript as
  one no-tools "Summarize this excerpt…" request, replace it with a
  `[Summary of the earlier conversation]` system message. Memoized by hash
  of the dropped prefix; on provider failure it degrades to static
  truncation — *compaction must never lose the turn.*
- The summary lands as a `system` message because it's standing context,
  not something to respond to.
- Note what is *not* compacted: the system prompt (identity) and the recent
  window (what the model is actively reasoning about).

## 14. Higher workflows

- **`sdlc.ts`** — `claw sdlc "feature"` chains plan → code → build → test →
  docs *as ordinary agent turns* with phase-specific directives sharing one
  session. No new machinery: the phase runner is `runTurn` in a loop with
  workspace diffs between phases.
- **`claw doc "topic"`** — one research turn: `web_search` → `web_fetch` →
  write markdown with references.
- **CLAW.md instructions** (`Agent.instructionsBlock`) — workspace
  `CLAW.md` / `AGENTS.md` (or `~/.claw/CLAW.md`) is appended to every
  system prompt: team conventions without touching code.
- **Custom commands** (`commands.ts`) — `.claw/commands/review.md` becomes
  REPL `/review $ARGUMENTS`: template expansion, workspace overrides user.
  The same trick as Claude Code's custom slash commands, ~60 lines.

## 15. Testing

**File: `src/selfcheck.ts`** — 68 assertions, zero test framework, zero
network. Principles:

1. **Test behavior, not structure.** The fan-out check counts *in-flight*
   sub-agents, not code shape. The budget check asserts routing *outcomes*.
2. **Fake servers over mocks of the client.** SSE parsers are tested
   against real chunked HTTP servers on localhost — the wire format is the
   contract; a hand-written mock of your own parser tests nothing.
3. **The fixture server is a real MCP server** (`test/fixtures/mcp-server.ts`)
   — spawned as a child process, speaks stdio JSON-RPC, triggers a sampling
   round-trip. If the fixture can do it, Firecrawl can.
4. **Real filesystems for real tools** — git tools run against a throwaway
   `git init` repo in tmp; serve persistence asserts an actual `.jsonl`
   exists.
5. **One command.** `node src/cli.ts selfcheck` — CI, docs, and demos use
   the same entry point.

## 16. Reading order & exercises

**First pass (2 hours, in this order):**

1. `src/types.ts` — all of it
2. `src/agent.ts` — `runTurn` only; ignore helpers
3. `src/guards.ts` — `runPoint` + `approvalGuard`
4. `src/tools/fs.ts` — the simplest tool file
5. `src/providers/mock.ts` — see how little "a model" really is

**Second pass:** `subagent.ts` → `router.ts` → `mcp.ts` → `oauth.ts` →
`serve.ts` → `repl.ts` → `selfcheck.ts`.

**Exercises (each is a real feature, roughly in difficulty order):**

1. Add a `read_many_files` tool (paths array, one result). *Teaches: tool
   shape, confine, output caps.*
2. Add a `--dry-run` flag: `deny` every risky tool at the approval gate and
   log what *would* have run. *Teaches: guards as policy objects.*
3. Add `maxUsd` to the sub-agent opts: a child whose ledger exceeds it is
   aborted like a timeout. *Teaches: ledger plumbing + AbortSignal.*
4. Render tool traces in the web UI: extend the SSE protocol with
   `{"type":"tool","name":…}` events emitted from the ACT phase.
   *Teaches: event-driven channels.*
5. Add `claw init --example` writing a `models` config with budgets and a
   `.claw/commands/test.md`. *Teaches: the config layering end-to-end.*
6. Add a `claw mcp whoami <name>` command: call the server's own userinfo
   with the stored OAuth token and print its expiry. *Teaches: the token
   store + refresh lifecycle.*
7. Swap `SessionStore` for a Redis implementation of the same four methods.
   *Teaches: why sessions are append-only lines — and how to run claw at
   scale (see DEPLOY.md §4).*

When you can explain why the approval gate is a separate hook point from
beforeTool, why `write_file` is `safe` but `git_commit` is `risky`, and
what breaks first without the iteration cap — you understand agentic
harnesses.
