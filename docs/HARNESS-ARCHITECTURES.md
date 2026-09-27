# Harness Architectures — An In-Depth Study Guide

*How the leading coding-agent harnesses actually work inside: Claude Code,
Codex CLI, Pi, and Devin — plus the open-source harnesses worth studying —
extracted from their own documentation, repositories, and the best
reverse-engineering writeups. Written for study: each chapter ends with the
design lessons worth stealing.*

> Companion docs: [RESEARCH.md](RESEARCH.md) is the feature comparison and
> adoption ledger; [GUIDE.md](GUIDE.md) teaches CLAW's own architecture;
> [BUILD.md](BUILD.md) is the build log. This file is the field survey.

---

## 0. The anatomy every harness shares

Strip the marketing and every harness in this document is the same skeleton:

```
┌────────────────────────────────────────────────────────────┐
│                      THE AGENT LOOP                        │
│   while (model returns tool calls):                        │
│       check permissions / sandbox        ← the policy layer│
│       execute tool, capture output       ← the tool layer  │
│       append result to history           ← context economy │
│   return final text                      ← the only exit   │
└────────────────────────────────────────────────────────────┘
```

The [systematic analysis in VILA-Lab's Dive-into-Claude-Code](https://github.com/VILA-Lab/Dive-into-Claude-Code)
puts it best: **the agent loop is a simple while-loop; the real engineering
lives in the systems around it** — context management, permissions, hooks,
and tool design. Every difference between harnesses is a difference in how
they answer five questions:

1. **Who may act?** (permission/sandbox model — §1.4, §2.2, §3.3)
2. **What does the model see?** (context economy — §1.5)
3. **What tools exist, and how fat are they?** (§1.3, §3.2)
4. **How do users inject policy?** (hooks/extensions — §1.6, §3.3)
5. **Where does it run?** (local process vs cloud VM — §4)

Keep those five questions in mind and every chapter below organizes itself.

---

## 1. Claude Code (Anthropic) — the opinionated loop

The most-studied harness, partly because the community has reverse-
engineered it in remarkable depth. Note: internal codenames below
(`nO`, `h2A`, `wU2`) come from community reverse-engineering, not official
Anthropic docs — treat them as labels, not API.

### 1.1 The master loop

A **single-threaded main loop over one flat message history** — no threads,
no swarms, no competing personas. The core is
`while (tool_call) → execute → feed results → repeat`, terminating only
when the model answers with plain text ([PromptLayer deep-dive](https://blog.promptlayer.com/claude-code-behind-the-scenes-of-the-master-agent-loop/)).
Anthropic's stated reason: *debuggability and reliability* — "do the simple
thing first": regex over embeddings, Markdown over databases.

An execution chain looks like `Grep → View → Edit → Bash(test) → answer`.
Surrounding the loop: StreamGen (streaming output) and a ToolEngine/
Scheduler (tool orchestration, model query queuing).

### 1.2 Real-time steering

An async dual-buffer message queue lets the user **inject new instructions
mid-task** without restarting — the agent adjusts its plan on the fly.
This is a bigger UX differentiator than it sounds: most harnesses (CLAW
included) only accept input between turns.

### 1.3 Tools — thin, uniform, regex-first

One uniform interface: JSON tool call → sandboxed execution → plain-text
result.

- **Read/discovery:** `View` (~2,000 lines default per read), `LS`, `Glob`.
- **Search:** `Grep` — regex modeled on ripgrep; **deliberately no vector
  DB or embeddings**.
- **Editing:** `Edit` (surgical patches) and `Write` (whole-file), with
  colorized diffs in the UI and a diffs-first review workflow.
- **Bash:** persistent shell sessions, risk-level classification of
  commands, confirmation prompts for dangerous ones, and injection
  filtering (blocks backticks and `$()` in user-controlled strings).
- **Specialized:** `WebFetch` (restricted to user-mentioned URLs),
  Notebook tools (Jupyter JSON), BatchTool (grouped operations).

### 1.4 Permissions and safety

Writes, risky Bash, and external tools (MCP/web) require explicit
allow/deny; whitelists and "always allow" rules are supported. Permission
**modes** layer on top: default / plan (read-only until a plan is
approved) / acceptEdits / bypassPermissions ([official docs](https://code.claude.com/docs/en/permissions)).
Commands are classified by risk; safety notes are appended to tool outputs
for both the model and the user. All calls are logged — a complete audit
trail.

### 1.5 Context economy

- **Auto-compaction** triggers at roughly 92% window usage: the
  conversation is summarized and key facts are carried forward (the `wU2`
  compressor in community writeups).
- **Memory is a Markdown file**: `CLAUDE.md` as project memory, re-injected
  every session. Again: files over databases.
- **TodoWrite** writes a JSON task list (ids, content, status); the UI
  renders it as a checklist, and — the subtle masterstroke — **system
  reminders re-inject the current todo state after tool uses**, keeping the
  plan inside the model's context on long runs.

### 1.6 Subagents and hooks

Subagents are dispatched via a Task tool for exploration or parallel
approaches: each gets a **fresh context window**, works in isolation, and
returns only a summary as a tool result — preserving the single-threaded
main loop. Depth is limited (subagents can't spawn subagents) to prevent
recursive explosion.

**Hooks** are user-defined shell commands at lifecycle events
(PreToolUse, PostToolUse, Stop, …) for gating, logging, and enforcement —
registered via config, receiving JSON on stdin
([hooks reference](https://code.claude.com/docs/en/hooks)). Hook decisions
don't bypass permission rules; they're another input into the same gate.

### 1.7 Lessons worth stealing

1. One flat loop; push complexity into the surroundings.
2. Regex and files beat embeddings and databases for code search and memory.
3. Re-inject state (todos, reminders) *after* tool uses, not just at turn start.
4. Subagents buy context isolation, not parallelism per se — the summary-back
   pattern keeps the main loop simple.
5. A diffs-first UI makes review the path of least resistance.

---

## 2. Codex CLI (OpenAI) — the sandboxed surgeon

Codex's bet is different: rather than an application-level permission
system, it pairs a **real OS-enforced sandbox** with a thin **approval
policy** on top ([repo](https://github.com/openai/codex),
[Windows sandbox post](https://openai.com/index/building-codex-windows-sandbox/),
[guide](https://www.philschmid.de/openai-codex-cli)).

### 2.1 Implementation

A **Rust core** (`codex-rs/`) distributed as static native binaries
(`x86_64-unknown-linux-musl`, `aarch64-apple-darwin`, …), packaged via npm
(`@openai/codex`) with a Bazel-built monorepo. Companions: an IDE
extension, a desktop app (`codex app`), and Codex Web (the cloud agent) —
one core, many surfaces.

### 2.2 The sandbox — OS enforcement, not prompt-level promises

| Platform | Mechanism |
| --- | --- |
| macOS | **Seatbelt** (`sandbox-exec`) profiles — file/network restrictions enforced by the kernel |
| Linux | **Landlock** (+ seccomp) — kernel-enforced filesystem/network policy |
| Windows | A dedicated restricted-token/AppContainer sandbox (announced 2026) |

Three sandbox levels: **read-only**, **workspace-write** (edits inside the
project only, network restricted), and **full access**.

### 2.3 The approval policy — a second, separate dial

Layered *on top of* the sandbox: **on-request** (agent decides when to
ask), **on-failure** (ask only when a sandboxed command fails and needs
escalation), **never** (rely on the sandbox alone). The key insight:
**what the agent *can* do and what the agent *may* do are two independent
dials.** Claude Code folds both into one permission system; Codex keeps
them orthogonal.

### 2.4 The loop and tools

Per the comparative writeups, Codex is also a single-agent event loop —
think → tool call → observe — but with a **shell-first, surgical** style:
fewer, more generic tools (shell + apply-patch) versus Claude Code's many
specialized ones. The "shell-first surgeon" nickname captures it. MCP is
supported, and config lives in `config.toml`.

### 2.5 Lessons worth stealing

1. Separate *capability* (sandbox) from *permission* (approval policy).
2. Application-level confinement is a courtesy; kernel-level confinement
   is a guarantee.
3. Fewer, more generic tools scale further than many bespoke ones —
   if the model is strong enough.
4. One Rust core, many surfaces (CLI, IDE, web) — build the engine once.

---

## 3. Pi (pi.dev) — the minimal harness

Pi — "phi" in the request — is the philosophical counterweight: *"There
are many agent harnesses, but this one is yours. Adapt Pi to your
workflows, not the other way around"* ([pi.dev](https://pi.dev/),
[repo](https://github.com/earendil-works/pi), by Mario Zechner).

### 3.1 Layered architecture

A clean package stack, each layer independently useful:

| Package | Role |
| --- | --- |
| `pi-ai` | Unified multi-provider LLM API (OpenAI, Anthropic, Google, …) |
| `pi-agent-core` | Agent runtime: tool calling + state management |
| `pi-coding-agent` | The interactive CLI — a thin composition of the layers below |
| `pi-tui` | Terminal UI with differential rendering |
| `pi-telemetry` | Vendor-neutral telemetry contracts + conformance tests |

### 3.2 Primitives, not features

Deliberately **~4 built-in tools, with `bash` doing most of the work**, and
a system prompt that fits on one page. No plan mode, no subagents, no
permission popups, no background bash *shipped* — all of those exist as
community packages/extensions you add when you actually need them. The
skill-file idea is Pi's signature move: instead of installing an extension,
you hand the agent a **skill file** that teaches it how to do something —
knowledge as a document, not code.

### 3.3 No permission system — containment delegated to the OS

Pi ships **no built-in permission system**; the agent inherits the
launching user's permissions. Containment is explicitly delegated to the
OS layer: Docker, a Gondolin micro-VM extension, or OpenShell. Radical,
but consistent: an application-level permission system can be prompt-
injected; a container can't.

### 3.4 Supply-chain hardening as a first-class feature

Pi's most underrated engineering: exact-pinned dependencies,
`min-release-age` to refuse same-day npm releases, lockfile-as-ground-
truth, `--ignore-scripts` installs, lifecycle-script allowlisting, and
scheduled audits. For an agent that runs `npm install`, the supply chain
*is* the attack surface.

### 3.5 Lessons worth stealing

1. A thin core stays auditable — CLAW's zero-dependency discipline is the
   same instinct.
2. Skill files (knowledge as markdown) are the cheapest extension
   mechanism ever invented — CLAW's CLAUDE.md + custom commands are the
   same idea.
3. If you won't build a permission system, you *must* build the container
   story; Pi is honest about this trade.
4. For an agent that executes `npm install`, the supply chain is part of
   the threat model.

---

## 4. Devin (Cognition) — the autonomous cloud employee

Devin inverts the local-CLI model: the harness is a **cloud VM**, the user
watches through a web IDE ([release notes](https://docs.devin.ai/release-notes/2026),
[capabilities](https://agents.4geeks.com/agent/devin-ai),
[review](https://every.to/chain-of-thought/coding-with-devin-my-new-ai-programming-agent)).

### 4.1 Architecture

Each session gets an isolated VM with shell, editor, browser, and repo
access. Because the agent runs in a controlled environment, OS-level
sandboxing comes free — the Codex insight, taken to the cloud. Workspaces
reset between sessions, so **persistence must be explicit**: plan files,
playbooks, and repos carry knowledge across runs.

### 4.2 Plan files and playbooks

Devin presents a **multi-step implementation plan** (files to change, tests
to run) before building — the user can edit the plan, which makes human
approval a *document review* rather than a permission dialog. **Playbooks**
are reusable, parameterized instructions — essentially custom commands for
an autonomous agent. Progress is reviewable via logs and diffs, and the
best results come from strong preparation, narrow access, and visible
verification.

### 4.3 Lessons worth stealing

1. A plan the human can *edit* beats a permission the human must *click*.
2. Ephemeral workspaces force explicit knowledge persistence — plan files
   and playbooks exist because the VM forgets.
3. Autonomy without visible verification is unusable; logs + diffs are the
   product.

---

## 5. The open-source harnesses worth studying

Short entries — each contributed a distinct idea:

- **SWE-agent (Princeton)** — the **Agent-Computer Interface (ACI)** paper:
  tools are an API design problem. Their findings — guardrails on edit
  formats (lint-after-edit), a compact file viewer — are why every harness
  now validates edits instead of parsing freeform output.
- **OpenHands (formerly OpenDevin)** — an **event-stream architecture**:
  everything (user input, agent action, observation) is an event on an
  append-only stream; the agent is a reducer over it. Great shape for
  replay, audit, and resumption — the same property CLAW's JSONL sessions
  have.
- **Aider** — **git-native**: every edit is a commit; the repo *is* the
  checkpoint/undo system. Also pioneered repository maps (a compressed
  tree + signatures view) to spend context wisely.
- **Cline / Roo Code** — the VS Code-native pattern: **Plan and Act as
  separate modes**, diffs approved file-by-file in the editor's own UI.
  Claw's permission modes are the same dial.
- **OpenCode, Goose (Block), Amp** — further evidence of the same loop;
  Goose's "extensions in any language via MCP-style declarations" and
  Amp's ruthless minimalism are worth a skim.

---

## 6. Cross-cutting patterns (the actual study material)

1. **The loop never changes.** Every disagreement is about the surround:
   policy, context, tools, extensibility.
2. **The permission spectrum.** Ask-everything (Cline default) →
   mode-dials (Claude Code, CLAW) → sandbox+policy separation (Codex) →
   delegated to the OS entirely (Pi, Devin-by-construction). Stronger
   guarantee = less application logic.
3. **Context economy is the real product.** Compaction thresholds
   (~92% in Claude Code), repo maps (Aider), subagent context isolation,
   todo re-injection — every harness's genuinely novel engineering is
   here, not in the loop.
4. **Memory is files.** CLAUDE.md, Pi's skills, Devin's plan files,
   Aider's conventions file. Nobody shipped a database for memory; the
   ones that tried lost to markdown.
5. **Extensibility axes:** tools (MCP), policy (hooks), knowledge (skill
   files/commands), surfaces (CLI/IDE/web). Pick which axes you expose.
6. **Single-agent with isolation beats multi-agent swarms** — Claude Code's
   subagent summary-back pattern and Pi's refusal to ship multi-agent at
   all both point the same way.

## 7. How CLAW maps (quick reference)

| Pattern (§ above) | CLAW |
| --- | --- |
| §1.1 single flat loop | `Agent.runTurn` — same shape |
| §1.5 compaction at ~92% | `compactAt` messages (tunable) + memoized LLM summary |
| §1.5 todo re-injection | `todo_write` returns the rendered list into context |
| §1.6 subagent isolation | `delegate` — own context/ledger/lock, summary-back receipts |
| §2.2/2.3 sandbox + policy | permission modes (`plan/acceptEdits/bypass`) at the app layer; kernel-level via DEPLOY.md hardening |
| §1.6 hooks | `userHooksGuard` — JSON on stdin, exit-2 veto |
| §3.2 skill files | `CLAW.md` + `.claw/commands/*.md` |
| §4.2 editable plans | plan mode + `todo_write` (document-editable plans are a future step) |
| §5 OpenHands event stream | JSONL sessions + SSE trace events |

## Sources

- [Dive-into-Claude-Code (VILA-Lab)](https://github.com/VILA-Lab/Dive-into-Claude-Code) ·
  [Claude Code master loop (PromptLayer)](https://blog.promptlayer.com/claude-code-behind-the-scenes-of-the-master-agent-loop/) ·
  [Claude Code A–Z (Agent Cookbook)](https://agent-cookbook.com/tutorial/how-anthropic-claude-code-actually-works-a-z-deep-dive) ·
  [Inside Claude Code: tools/memory/hooks/MCP (Penligent)](https://www.penligent.ai/hackinglabs/tr/inside-claude-code-the-architecture-behind-tools-memory-hooks-and-mcp/) ·
  [Claude Code permissions](https://code.claude.com/docs/en/permissions) ·
  [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Codex CLI repo](https://github.com/openai/codex) ·
  [Codex CLI guide (Philschmid)](https://www.philschmid.de/openai-codex-cli) ·
  [Codex Windows sandbox (OpenAI)](https://openai.com/index/building-codex-windows-sandbox/) ·
  [Codex sandboxing (Greyling)](https://cobusgreyling.substack.com/p/openai-codex-sandboxing) ·
  [Claude Code vs Codex (ivan.digital)](https://blog.ivan.digital/claude-code-vs-openai-codex-agentic-planner-vs-shell-first-surgeon-d6ce988526e8)
- [Pi](https://pi.dev/) ·
  [Pi repo](https://github.com/earendil-works/pi) ·
  [Pi guide (ExplainX)](https://explainx.ai/blog/pi-minimal-agent-harness-mario-zechner-guide-2026/) ·
  [Pi on HN](https://news.ycombinator.com/item?id=47143754)
- [Devin release notes](https://docs.devin.ai/release-notes/2026) ·
  [Devin capabilities](https://agents.4geeks.com/agent/devin-ai) ·
  [Coding with Devin (Every.to)](https://every.to/chain-of-thought/coding-with-devin-my-new-ai-programming-agent) ·
  [Design space of agent systems (arXiv)](https://arxiv.org/html/2604.14228v1)
