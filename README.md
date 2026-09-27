# CLAW

A **terminal coding agent** — the OpenCode × Claude Code experience in one
zero-dependency CLI. CLAW chats with you, reads and edits files in your
workspace, runs commands, searches code, fetches web pages, and keeps a
session history you can resume tomorrow.

It implements, end to end, the same architecture described in `../claw-docs`
and demonstrated by `../claw-orchestrator`: the **Provider / Tool / Channel**
plugs, the **TAOR loop** (Think → Act → Observe → Repeat), the **guard
stack** (allowlist → path confinement → approval gate → output cap → secret
scan), the **session lock**, the **iteration cap**, and the **caches**
(whole-turn response cache + idempotent tool-result cache).

Runs on **Node ≥ 23.6** with zero install — native TypeScript, no build step,
no npm dependencies at runtime.

```
  ┌───────────────────────────────────────────────┐
  │         CLAW — terminal coding agent          │
  └───────────────────────────────────────────────┘
```

## Quick start

```bash
cd claw
node src/cli.ts                     # interactive chat (falls back to a mock if no API key)
node src/cli.ts -M "what is 7 * 6"  # force the offline scripted mock, one-shot
node src/cli.ts selfcheck           # 79 built-in assertions (no network needed)
```

To use a **real model**, set one of:

```bash
export CLAW_API_KEY=sk-...          # OpenAI-compatible: OmniRoute / Ollama / LM Studio / OpenAI
export CLAW_BASE_URL=http://127.0.0.1:11434/v1
export CLAW_MODEL=qwen2.5-coder:7b
export ANTHROPIC_API_KEY=sk-ant-... # then: claw --anthropic
```

`claw init` writes a documented `.claw.json`; `claw doctor` checks your setup.

## Commands

| Command | What it does |
| --- | --- |
| `claw` | Interactive REPL with streaming output |
| `claw "fix the build"` | One-shot: ask once, get an answer, exit (`--json` for machine-readable output) |
| `claw run [file...]` | Task mode — whole file(s) sent as ONE message |
| `claw doc "topic"` | Research + write a markdown doc (`docs/<slug>.md`, or `-o path`) |
| `claw sdlc "feature"` | Full SDLC flow: plan → code → build → test → docs (`--phases plan,code`) |
| `claw mcp <add\|list\|remove\|test\|login\|logout>` | Manage MCP servers; `login` runs OAuth for a server |
| `claw serve` | Headless HTTP channel: `POST /chat` drives the same agent |
| `claw models` | List model aliases + their backends (multi-model routing) |
| `claw continue` | Resume the most recent session |
| `claw init` | Write a project `.claw.json` (`claw init --example` = full-featured sample) |
| `claw doctor` | Environment + API connectivity report |
| `claw selfcheck` | The built-in assertion suite |
| `claw sessions` | List saved sessions |

### Flags

```
-m, --model <name>        model to use
-b, --base <url>          OpenAI-compatible base URL
-k, --api-key <key|env>   API key, or the env var holding it
    --anthropic           use the Anthropic API
-M, --mock                force the scripted mock (offline demo)
-w, --workspace <dir>     the ONE folder the agent may touch
-y, --yolo                auto-approve risky tools (no human gate)
    --no-stream           disable streaming
    --no-cost             hide the cost line
-v, --verbose             show the Think→Act→Observe trace
    --phases <list>       (sdlc) run only these phases, e.g. plan,code,test
-o, --out <path>          (doc) output path for the document
    --port <n>            (serve) port to listen on (default: random free port)
    --dry-run             deny every risky AND file-mutating tool, logging what WOULD have run
    --permission-mode <m>  default | plan (read-only: present a plan) | acceptEdits (edits auto) | bypass
    --host <addr>         (serve) bind address (default 127.0.0.1; 0.0.0.0 to expose)
    --url <url>           (mcp add) register a remote http MCP endpoint
    --trusted             (mcp add) skip the approval gate for that server
    --user                (mcp add/remove) edit ~/.claw/config.json instead of .claw.json
```

### REPL slash commands

`/help` `/model [name]` `/backends` `/mode [plan|acceptEdits|bypass]` `/clear` `/compact` `/cost`
`/usage` `/export [file]` `/init` `/yolo` `/allow [prefix|list]` `/unallow <prefix>`
`/sessions` `/resume <id>` `/quit`

Two extra input modes, like the best terminal agents:

| Prefix | What it does |
| --- | --- |
| `!<cmd>` | Run a shell command **directly** (no approval — you typed it). Its output joins the conversation so you can ask about it. |
| `#<note>` | Save a **memory note** to the workspace `CLAW.md` (under `## Memory notes`). Every future session reads it. |

Press **Tab** to autocomplete slash commands (built-in + your custom `.claw/commands/*.md`).

## The architecture (how it all fits)

```
┌────────────────────────────────────────────────────────────┐
│  cli.ts — entry: flags, subcommands, wires the world        │
│  factory.ts config → providers: aliases, multi-key, mock   │
│  router.ts  multi-backend routing: failover / round-robin /│
│             weighted + circuit breaker + key rotation +    │
│             per-backend budgets (max calls/tokens/USD)     │
│  subagent.ts delegate: recursive sub-agents (one task or   │
│             parallel fan-out with bounded concurrency),    │
│             depth cap, timeout via AbortSignal, ledger merge│
│                                                            │
│  config.ts   layered: flags > .claw.json > ~/.claw/config  │
│              > CLAW_* env > defaults                       │
│                                                            │
│  providers/  Provider plug — streamed LLM adapters:        │
│    openai.ts   OpenAI-compatible SSE (OmniRoute/Ollama/…)  │
│    anthropic.ts Anthropic Messages API                     │
│    mock.ts     scripted offline model for demos/tests      │
│                                                            │
│  tools/      Tool plug — one action each:                  │
│    calc.ts     safe arithmetic (no eval)                   │
│    fs.ts       read_file (paged, line-numbered) ·          │
│                write_file · list_dir · mkdir ·             │
│                delete_file (gated) · move_file (no-clobber)│
│    edit.ts     edit_file — one search/replace or an atomic │
│                edits[] array (all-or-nothing)              │
│    search.ts   glob / grep (context lines, literal, case,  │
│                files-only, multiline) over the workspace   │
│    shell.ts    shell — the risky one, goes through the     │
│                approval gate                               │
│    git.ts      git_status / git_diff / git_log (read) and  │
│                git_commit (behind the approval gate)       │
│    todo.ts     todo_write — the session task list          │
│    shell.ts    shell (+background:true) → task_output /    │
│                task_kill for long-running commands         │
│    web.ts      web_fetch — read-only, http(s) only         │
│    web_search.ts search the web (TinyFish/Tavily/Brave/DDG)│
│    mcp tools   any MCP server → CLAW tools (stdio + http)  │
│    delegate    sub-agent handoff (agent-to-agent)          │
│                                                            │
│  agent.ts    THE LOOP: TAOR with session lock, iteration   │
│              cap, response cache, tool cache, LLM context  │
│              compaction, AbortSignal shutdown              │
│  guards.ts   hook points (onTurnStart → … → onTurnEnd) +   │
│              allowlist / path-confine / approval-modes /   │
│              output-cap / secret-scan / loop-detect /      │
│              user hooks (beforeTool/afterTool/onTurnEnd)   │
│  mcp.ts      MCP client — stdio + streamable HTTP, tools   │
│              mapped + security-classified + sampling       │
│  sdlc.ts     plan → code → build → test → docs + `claw doc`│
│  repl.ts     Channel plug — the interactive terminal       │
│  serve.ts    Channel plug — headless HTTP (POST /chat)     │
│  sessions.ts JSONL persistence + prompt history            │
│  cost.ts     token/cost ledger                             │
│  selfcheck.ts 79 assertions incl. fake-server stream tests │
└────────────────────────────────────────────────────────────┘
```

### The loop

1. **Think** — call the provider with the conversation + tool definitions.
   Text streams straight to your terminal. Transient provider failures
   (429/408/5xx, network drops) retry automatically with exponential
   backoff + jitter, honoring `Retry-After`.
2. **Act** — if the model asks for tools, run them: consecutive **read-only**
   calls execute in *parallel*, while anything that mutates (writes, shell,
   git) stays strictly *sequential*. Before a tool runs, the guard stack has
   its say (below). Risky tools pause and ask you:
   `⚠ approve shell(...)? [y/N]`.
3. **Observe** — the tool result feeds back as a `tool` message; the model
   reasons again.
4. **Repeat** — until the model answers with text (the only happy exit), an
   error, or the iteration cap trips (the runaway guard).

### The security model

Every tool call passes through seven hook points, cheapest-first:

| Guard | Point | What it stops |
| --- | --- | --- |
| rate-limit | onTurnStart | > 30 turns/minute |
| loop-detect | afterLLM | the model repeating the same call forever |
| path-confine | beforeTool | file tools escaping the workspace |
| shell-allowlist | beforeTool | allowlisted commands skip approval |
| approval | approveTool | every risky tool asks the human (`-y` skips; `--permission-mode plan` denies mutating tools, `acceptEdits` auto-runs edits) |
| user hooks | beforeTool/afterTool/onTurnEnd | your shell commands observe calls — beforeTool exit 2 vetoes |
| output-cap | afterTool | oversized results fed back to the model |
| secret-scan | afterTool | credentials in tool output are redacted |

Defense in depth: the path-confine guard AND `confine()` inside every file
tool both enforce the workspace boundary; the secret scanner runs both on
tool output and on the final answer.

### Caching

- **Response cache** — an exact-repeat conversation costs zero LLM calls.
- **Tool cache** — idempotent tools (`calc`, `read_file`, `glob`, `grep`)
  memoize by name+args for 10 minutes; side-effecting tools never cache.
- **Provider prompt cache** — read/write cache tokens are surfaced in every
  usage report and the cost line (`cached 512`), like the orchestrator's
  telemetry.

## Configuration

Priority: **flags > `.claw.json` > `~/.claw/config.json` > `CLAW_*` env >
defaults**, merged per key. Everything is optional — omit keys to fall
through.

```jsonc
// .claw.json
{
  "baseURL": "http://127.0.0.1:20128/v1", // OmniRoute gateway
  "model": "oc/deepseek-v4-flash-free",   // pin the model so caches hit
  "apiKey": "OMNIROUTE_API_KEY",          // name of an env var, or a literal key
  "maxIterations": 16,
  "workspace": ".",
  "autoApprove": false,                   // true = -y always on
  "permissionMode": "default",            // default | plan | acceptEdits | bypass
  "hooks": {                              // user hooks: JSON on stdin; exit 2 vetoes
    "beforeTool": "node scripts/check-tool.js",
    "onTurnEnd": "node scripts/audit-answer.js"
  },
  "stream": true,
  "riskyTools": ["shell"],
  "shellAllowlist": ["echo", "date", "pwd", "ls", "whoami", "hostname"],
  "outputCap": 4000,
  "models": { /* see the multi-model routing section */ },
  "subagents": { "enabled": true, "maxDepth": 3, "timeoutMs": 120000 },
  "mcpServers": { /* see the MCP section */ }
}
```

No API key anywhere? CLAW falls back to the scripted mock so you can always
try it offline — the loop, tools, guards, and rendering are identical.

## MCP integration (Model Context Protocol)

CLAW is an MCP **client**: any MCP server — stdio (`npx`-spawned) or remote
HTTP — becomes a set of CLAW tools, gated by the same guard stack.

```bash
# Firecrawl (web search + scrape + crawl) — stdio
claw mcp add firecrawl npx -y firecrawl-mcp-server
# TinyFish (web search + fetch, free) — remote http, OAuth handles auth
claw mcp add tinyfish --url https://agent.tinyfish.ai/mcp --trusted
# remote http with an authenticated endpoint (token from the environment):
claw mcp add my-server --url https://example.com/mcp --header "Authorization: Bearer ${MY_TOKEN}"

claw mcp list               # what's configured
claw mcp test firecrawl     # connect + list its tools
claw mcp remove firecrawl
```

Set API keys in env (`FIRECRAWL_API_KEY`, `TINYFISH_API_KEY`, …) or in the
server's `env` block. MCP tools are named `mcp_<server>_<tool>`. Security:
tools that smell read-only (`search/read/list/get/query/fetch/…`) run without
approval but their output is secret-scanned; everything else hits the human
approval gate unless the server was registered `--trusted`. The selfcheck
covers both transports (stdio against a fixture server, HTTP against a fake
endpoint) end to end.

**MCP sampling** — servers can also call the *model* back via
`sampling/createMessage` (e.g. a scraper asking the model to summarize a
page). CLAW answers with its own provider: the server's messages are
flattened into one prompt, completed with no tools, and returned. Without a
sampling-capable client a server gets a clean JSON-RPC error instead of a
hang.

**MCP OAuth** — remote servers that need real authentication get the full
Authorization Code + PKCE flow (`src/oauth.ts`), zero dependencies:

```bash
claw mcp add acme --url https://mcp.acme.dev/mcp --oauth          # discover everything
claw mcp add acme --url https://mcp.acme.dev/mcp --oauth --auth-server https://auth.acme.dev --scopes read,write
claw mcp login acme     # opens your browser; a local callback captures the code
claw mcp logout acme    # forget stored tokens
```

On first use CLAW discovers the authorization server via well-known URIs,
registers itself dynamically (RFC 7591), generates a PKCE challenge
(RFC 7636), opens your browser, and exchanges the code at a one-shot local
callback server. Tokens persist in `~/.claw/mcp-tokens.json` and refresh
automatically via the refresh_token grant; a 401 mid-session triggers the
login flow once and retries. The flow is fully tested offline: the
selfcheck spins up a fake authorization server that *enforces* PKCE and
walks every step. (Simple token auth is also available via
`--header "Authorization: Bearer ${MY_TOKEN}"`.)

## Web search

`web_search` is a native tool (no MCP needed) that picks a backend from
`CLAW_SEARCH_PROVIDER` (or `auto`):

1. `TINYFISH_API_KEY` → TinyFish search (free tier)
2. `TAVILY_API_KEY` → Tavily
3. `BRAVE_API_KEY` → Brave
4. nothing set → DuckDuckGo HTML (keyless, best effort)

Pair it with `web_fetch` to read the pages it finds — that's the
research loop (`claw doc` drives it automatically).

## Doc creation

```bash
claw doc "streaming LLM inference"                # → docs/streaming-llm-inference.md
claw doc "our API design" -o docs/API.md
```

One research turn: the agent searches the web, reads sources, writes a
structured markdown document with a References section, and reports the path.

## The SDLC flow

```bash
claw sdlc "build a todo API"                     # plan → code → build → test → docs
claw sdlc --phases plan,code "todo API"          # just the first two phases
```

Each phase is a real agent turn with a phase-specific directive, sharing one
session so context carries forward. After every phase CLAW diffs the workspace
and reports created / changed / removed files, and each phase's cost is
added to the ledger. Everything is persisted — `claw continue` resumes the
whole run.

## Multi-model routing & API keys (OmniRoute-style)

One CLI, many models, many keys. A `models` section in `.claw.json` defines
**aliases**; each alias can fan out to several **backends** (own endpoint,
model, and key) with a routing strategy:

```jsonc
"models": {
  "free-stack": {                     // an alias you can -m / /model into
    "strategy": "failover",            // failover | roundrobin | weighted
    "backends": [
      { "baseURL": "http://127.0.0.1:20128/v1", "model": "oc/deepseek-v4-flash-free", "apiKey": "KEY_A" },
      { "baseURL": "http://127.0.0.1:20128/v1", "model": "oc/qwen-coder", "apiKey": "KEY_B", "keys": ["KEY_B", "KEY_C"] },
      { "baseURL": "https://api.openai.com/v1", "model": "gpt-4o-mini", "apiKey": "KEY_D",
        "budget": { "maxCalls": 200, "maxUsd": 2.0 } }   // spend ceiling per backend
    ]
  }
}
"subagents": { "enabled": true, "maxDepth": 3, "timeoutMs": 120000, "maxConcurrency": 4, "worktree": false,
               "budget": { "maxInputTokens": 200000 } }
```

- **failover** — try backends in order, skip recently-failed ones (circuit
  breaker with a 30s cooldown), use the first success. A backend with
  `keys: [A, B]` becomes two failover variants, so **401/429 rate limits
  rotate to the next key** automatically.
- **roundrobin** — alternate to spread load. **weighted** — pick by `weight`.
- **budgets** — a backend with a `budget` (`maxCalls`, `maxInputTokens`,
  `maxOutputTokens`, `maxUsd`) is skipped once its spend crosses any limit:
  cheap/free backends serve until their quota is exhausted before paid ones
  are touched. `/backends` shows live spend per backend (`… SPENT` when
  exhausted).
- `claw models` shows every alias/backend and whether its key resolves;
  in the REPL, `/model <alias>` switches and `/backends` shows live status
  (which backend answered, errors, call counts, budget spend).
- Plain model names still work: `-m some-model` is a single backend built
  from `baseURL`/`model`/`apiKey`. No keys anywhere and no aliases → the
  scripted mock, as before.

## Sub-agents (agent-to-agent handoff)

The `delegate` tool lets the agent spawn **isolated sub-agents** for
well-scoped subtasks: fresh conversation, own session lock, own cost ledger,
same tool set and guards. When a sub-agent finishes — or its timeout aborts
it — the workflow **closes cleanly**: the in-flight model call is aborted
via AbortSignal, the session lock is released, the token usage is merged
into the parent ledger, and the parent gets a structured receipt
(`[sub-agent #1 complete, 3 call(s)] … [sub-agent #1 end]`).

Pass `task` (string) for one sub-agent, or `tasks: [...]` (array) to **fan
out to N sub-agents in parallel** — a bounded pool (`subagents.maxConcurrency`,
default 4) runs them at once and the receipts return in the caller's task
order. One failing task becomes an `[error]` receipt instead of sinking the
fan-out. With `"subagents": { "worktree": true }`, each parallel task also
gets its **own git worktree** (branch `claw/task-N…`) so file edits never
collide — branches stay behind on purpose, merging is the human's call.

Delegation is recursive up to `subagents.maxDepth`; deeper attempts are
rejected with a clear message so runaway delegation can't happen. Each
sub-agent can set its own `timeout_ms`. Disable entirely with
`"subagents": { "enabled": false }`.

## Git integration

`git_status`, `git_diff`, and `git_log` are read-only tools; `git_commit`
stages (`add -A` unless `add_all=false`) and commits behind the **human
approval gate**, like `shell`. Unlike `shell`, the git tools spawn the `git`
binary directly with an argv array — no shell interpolation, nothing to
inject. Typical flow: the agent edits files, checks `git_diff`, then asks
you to approve a `git_commit`.

## The HTTP channel (`claw serve`)

```bash
claw serve --port 8787            # GET /        → built-in web chat UI
curl -s localhost:8787/health     # POST /chat   → the same agent over HTTP
curl -s localhost:8787/chat -d '{"message":"what files are here?"}'
# pass session_id back to continue that conversation:
curl -s localhost:8787/chat -d '{"message":"and in docs/?","session_id":"sess_abc123"}'
# add "stream": true → SSE: live text deltas + tool-trace events, then one done event:
curl -sN localhost:8787/chat -d '{"message":"hi","stream":true}'
```

Same agent, same tools, same guard stack — one loop, many sessions.

**The web workbench** (`GET /`) is the flagship surface, designed
Apple-clean (refined dark, hairlines, one restrained accent) and built as
an IDE, not a chat box:

- **Activity rail + panels** — sessions, workspace **file explorer**
  (click a file to @-reference it), **skills & commands**, **connected MCP
  servers** with their tools, and a **settings panel** (model, provider,
  allowlist, risky tools, hooks, endpoint).
- **Permission mode** is a segmented control in the title bar:
  Default / Plan / Auto-edit / Bypass — it talks to the same gate the
  terminal uses (`POST /mode`).
- **Tool-trace timeline** — every tool call is a card (`running → ✓ 42ms`)
  with args/result expanded on click, plus a collapsible **console pane**
  (Timeline and Raw-events views) like an IDE's terminal.
- **Composer** — `@` to reference workspace files (autocomplete from the
  live file tree), `/` for custom commands, and a paperclip to **attach
  files** (uploaded into `attachments/`, auto-referenced in the message).
- Sessions dropdown in the title bar; every past conversation replays via
  `/history`.

Zero dependencies, one editable HTML file (`web/index.html`). The UI is a
pure projection of the same event stream the terminal sees — DeepSeek
Harness's core idea.

**Real onboarding, OpenCode-style.** With no API key configured, `/chat`
answers `428 setup_required` and the workbench opens a **Connect a model**
screen: pick OpenAI, Anthropic, OpenRouter, Ollama (local, no key), or any
custom OpenAI-compatible endpoint; paste the key; save. The key is
persisted to the standard layered config (`~/.claw/config.json`, or the
project `.claw.json` if one outranks it — permissions 600) and the running
server **swaps the provider live** — no restart. Sessions get **titles**
derived from their first message, shown everywhere instead of ids. All
state lives under `~/.claw/` (override with `$CLAW_HOME`). Session histories persist to `~/.claw/sessions/`
(visible to `claw continue`), and concurrent turns on one session are
refused by the session lock. A serve process has no TTY, so **risky tools
are denied by default** — run with `-y` only if you accept the consequences.

## Session summaries

When you leave the REPL, CLAW asks the model for a one-paragraph summary of
what happened and stores it in the session's header (best-effort — a
failing provider just skips it). `claw continue` and `/resume` re-inject
that summary as a system message, so resuming a long session re-orients
the model instantly instead of replaying history cold.

## Project instructions & custom commands

**`CLAW.md`** — put one in the workspace (or `~/.claw/CLAW.md`; `AGENTS.md`
works too) and its content is appended to every system prompt in every
channel: coding conventions, house rules, "always run the tests after
edits". Capped at 8k chars, re-read per session.

**Custom commands** — a markdown file in `.claw/commands/` (workspace) or
`~/.claw/commands/` (user) becomes a REPL slash command:

```markdown
<!-- .claw/commands/review.md -->
Review $ARGUMENTS for security bugs. Focus on file $1.
Check the guard stack rules in docs/GUIDE.md before proposing fixes.
```

```bash
/review src/auth.ts
```

`$ARGUMENTS` is the whole argument string; `$1..$9` are individual words.
Workspace commands shadow user commands; `/help` lists them.

## The terminal UI

Everything renders through a small zero-dependency ANSI layer (`src/render.ts`):

- **Chat panels** — streamed assistant text appears in a left-guttered panel
  (`│ …`) that auto-wraps at your terminal width and closes with a corner
  (`` └─ ``); fenced code blocks get a cyan gutter and a `code: <lang>` header.
- **Live trace** — each tool call is a marked line: `` ⚙ `` think, `` ▶ `` act,
  `` ◀ `` observe, `` ✗ `` error, `` ⚡ `` cache hit, `` ⋮ `` sub-agent events
  (spawn/complete), all dim-styled and never glued to streamed text.
- **Rich rendering** — the non-streaming path (`--no-stream`) renders
  headers, bold, inline code, lists, blockquotes, tables, and fenced code.
- **Turn summaries** — every turn ends with `` ✻ N tool calls · in … · out … · $
  ``
  and the REPL prompt is `` claw (model) ❯ ``.

## Sessions & history

Every turn is appended to `~/.claw/sessions/<id>.jsonl`. `claw continue`
resumes the most recent one, `/sessions` lists them, `/resume <id>` jumps
into any of them. Typed prompts are kept in `~/.claw/history` for
arrow-key recall.

## Testing

```bash
node src/cli.ts selfcheck   # 69 checks, no network
npm run typecheck           # tsc --noEmit
```

The selfcheck covers the pure helpers (glob → regex, arg parsing, allowlist),
every guard (allow/deny/modify/abort), the full agent loop (tool call →
observe → final answer), both caches, the session lock, compaction (static +
the LLM summarize step and its fallback), the calc parser, the DuckDuckGo
search parser, the **router** (failover, round-robin, per-backend budgets
with live spend tracking), **sub-agents** (single + parallel fan-out with a
bounded-concurrency detector, ledger merge, depth cap, timeout-driven
abort), the **git tools** (against a throwaway repo) and **worktrees**
(create → isolated branch → remove), the **serve channel** (health, session
continuity, persistence, web UI route, **SSE streaming**), **session
summaries** (summarize-on-close + meta roundtrip), **project instructions**
(CLAW.md + AGENTS.md fallback), **custom commands** (discovery +
`$ARGUMENTS`/`$1` expansion), a **real CLI spawn** of `--json`, and —
against local fake servers — the **streaming SSE parsers for both the
OpenAI-compatible and Anthropic wire formats**, plus the **MCP client over
stdio (against a fixture server) and over the streamable HTTP transport**,
including **MCP sampling** in both directions, **`${ENV}` auth headers**,
and the **full MCP OAuth flow** (discovery → dynamic registration → PKCE →
exchange → retry, plus refresh) against a fake authorization server that
enforces PKCE — plus **permission modes** (plan denies all mutating tools
with zero human prompts; acceptEdits auto-runs edits but still gates
shell), **user hooks** (beforeTool exit-2 veto), **todo_write**, and
**background shell** (task id → polling → kill), and the **web workbench
projections** (`/sessions` list + `/history` replay).

## Harness research

CLAW's feature set is benchmarked against Claude Code, Codex CLI, Devin,
and Pi in [docs/RESEARCH.md](docs/RESEARCH.md) — the comparison matrix,
what was adopted (permission modes, hooks, todo list, background shell)
and what was rejected with reasons. For the **architectures themselves** —
how each harness works inside (loops, sandboxes, context economy,
extensibility) — read [docs/HARNESS-ARCHITECTURES.md](docs/HARNESS-ARCHITECTURES.md).

## Where to grow it (matches the claw docs)

- **Token store backends** — `~/.claw/mcp-tokens.json` today; an OS
  keychain / encrypted store behind the same interface.
- **Worktree auto-merge** — the parallel-delegate worktrees currently stay
  behind on `claw/*` branches for human review; a supervised merge step is
  the natural follow-up.
- **More surfaces** — the same `/chat` API (SSE tool-trace events included)
  would drive a Telegram/Slack adapter with no agent changes.
- **Redis session store** — the four-method `SessionStore` interface is the
  seam; see DEPLOY.md §4.2 for the scaling ladder.

**Learn how it's all built:** [docs/GUIDE.md](docs/GUIDE.md) is the
textbook — the mental model, every module, why each design choice was made,
a reading order, and exercises. [docs/BUILD.md](docs/BUILD.md) is the
chronological build log, including the chapter-by-chapter mapping to Code
with Antonio's *Build Your Own Claude Code* course
([repo](https://github.com/code-with-antonio/nightcode)).
**Run it in production:** [docs/DEPLOY.md](docs/DEPLOY.md) covers
deployment shapes, systemd/Docker with OS-level confinement, TLS + auth
proxies, scaling to many instances, cost governance, and a security
hardening checklist.

## Files

```
claw/
├── bin/claw            bash launcher (node src/cli.ts "$@")
├── package.json        type: module, no runtime deps
├── tsconfig.json       strict, erasable-syntax-only
├── docs/GUIDE.md       the learning guide: how everything is built & why
├── docs/BUILD.md       living build log (+ NightCode course mapping)
├── docs/DEPLOY.md      production deployment, security & scaling guide
├── docs/HARNESS-ARCHITECTURES.md   in-depth study: Claude Code / Codex / Pi / Devin internals
├── web/index.html      the local web app (sessions · streaming chat · trace timeline)
├── vscode/             VS Code extension — thin client of claw serve
└── src/
    ├── cli.ts          entry point
    ├── agent.ts        the TAOR loop (+ LLM compaction, CLAW.md instructions)
    ├── commands.ts     custom slash commands (.claw/commands/*.md)
    ├── config.ts       layered config (+ MCP server management)
    ├── cost.ts         token ledger
    ├── guards.ts       guard stack + hook framework
    ├── mcp.ts          MCP client: stdio + streamable HTTP + sampling + OAuth
    ├── oauth.ts        OAuth 2.0 Authorization Code + PKCE (zero deps)
    ├── render.ts       terminal UI (colors, fences, approval prompt)
    ├── serve.ts        HTTP channel: /chat, /health, built-in web UI
    ├── subagent.ts     delegate tool: single + parallel sub-agents
    ├── providers/
    │   ├── router.ts   multi-backend routing + circuit breaker + budgets
    │   └── factory.ts  config → providers (aliases, multi-key)
    ├── repl.ts         interactive shell + slash commands
    ├── sdlc.ts         SDLC phase runner + doc creation + file diffs
    ├── selfcheck.ts    assertion suite
    ├── sessions.ts     JSONL persistence
    ├── types.ts        shared vocabulary (Provider / Tool / Guard / ChatMsg)
    ├── util.ts         helpers (ANSI, SSE, glob, cost table…)
    ├── providers/      openai.ts · anthropic.ts · mock.ts
    └── tools/          calc.ts · fs.ts · edit.ts · search.ts · shell.ts ·
                        git.ts · web.ts · web_search.ts
```
