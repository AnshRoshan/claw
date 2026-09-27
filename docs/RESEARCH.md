# CLAW — Harness Research & Self-Evaluation

*The best features of the leading coding-agent harnesses, evaluated against
CLAW, with an honest adopted/rejected ledger.* Researched 2026-09-07.

## 1. The harnesses

| Harness | One-line philosophy | Sources |
| --- | --- | --- |
| **Claude Code** (Anthropic) | The opinionated, feature-complete terminal agent: permission modes, hooks, subagents, TodoWrite, CLAUDE.md memory | [permissions](https://code.claude.com/docs/en/permissions), [hooks](https://code.claude.com/docs/en/hooks), [hooks guide](https://code.claude.com/docs/en/hooks-guide), [best practices](https://smartscope.blog/en/generative-ai/claude/claude-code-best-practices-advanced-2026/) |
| **Codex CLI** (OpenAI) | Two-layer control: an OS-enforced **sandbox** (read-only / workspace-write / full-access) under an **approval policy** (on-request / on-failure / never) | [Codex CLI guide](https://www.philschmid.de/openai-codex-cli), [Windows sandbox](https://openai.com/index/building-codex-windows-sandbox/), [sandboxing writeup](https://cobusgreyling.substack.com/p/openai-codex-sandboxing) |
| **Devin** (Cognition) | Fully autonomous cloud agent; structure via **plan files**, playbooks, and reviewable progress (logs/diffs); browser + CLI + editor tools | [release notes](https://docs.devin.ai/release-notes/2026), [capabilities](https://agents.4geeks.com/agent/devin-ai), [review](https://every.to/chain-of-thought/coding-with-devin-my-new-ai-programming-agent) |
| **Pi** (pi.dev, "phi" in the request) | The **minimal** harness: primitives, not features; ~4 tools with `bash` doing most of the work; everything else via extensions/skills | [pi.dev](https://pi.dev/), [HN discussion](https://news.ycombinator.com/item?id=47143754), [guide](https://explainx.ai/blog/pi-minimal-agent-harness-mario-zechner-guide-2026/) |

## 2. Feature matrix (CLAW vs the field)

| Feature | Claude Code | Codex CLI | Devin | Pi | CLAW (before) | CLAW (now) |
| --- | --- | --- | --- | --- | --- | --- |
| Agent loop (tool → observe → repeat) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Permission/ask gate | ✓ | ✓ | – | ✗ | ✓ | ✓ |
| **Permission modes** (plan / accept-edits / bypass) | ✓ | ≈(sandboxes) | – | ✗ | ✗ | ✓ `--permission-mode` |
| **User hooks** (shell commands around tools) | ✓ | ✗ | ✗ | ≈(extensions) | ✗ | ✓ `hooks` config |
| **Session task list** (TodoWrite) | ✓ | ≈ | ≈(plan file) | ✗ | ✗ | ✓ `todo_write` |
| **Background shell + task polling** | ✓ | ≈ | ✓ | ✗ | ✗ | ✓ `shell{background}` + `task_output`/`task_kill` |
| Subagents / delegation | ✓ | ✗ | ≈ | ≈(packages) | ✓ (parallel, budgets, worktrees) | ✓ richer |
| Project memory file | CLAUDE.md | ≈AGENTS.md | ✗ | ≈skills | ✓ CLAW.md/AGENTS.md | ✓ |
| Custom slash commands | ✓ | ✗ | ✗ | ≈prompts | ✓ `.claw/commands/` | ✓ |
| MCP client (+sampling, OAuth) | ✓ | ✓ | ✗ | ✗ | ✓ | ✓ |
| Multi-model routing + budgets | ✗ | ✗ | ✗ | ≈extensions | ✓ | ✓ |
| Headless JSON output | ✓ `-p --output-format` | ✓ | ✓ | ✗ | ✓ `--json` | ✓ |
| Auto-compaction (LLM summarize) | ✓ /compact | ✓ | ✓ | ✗ | ✓ | ✓ |
| Cost/usage ledger | ✓ | ✗ | ≈ | ✗ | ✓ | ✓ |
| Guard stack (7 hook points, secret scan, confinement) | ≈permissions | ≈sandbox | ✗ | ✗ | ✓ | ✓ |
| Web UI / HTTP channel | ✗ | ✗ | ✓(cloud) | ✗ | ✓ serve + web UI | ✓ |
| VS Code extension | ✓ | ✓ | ✓ | ✗ | ✓ (thin client) | ✓ |
| Browser tool | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ (rejected) |
| OS-level sandbox | ✗ | ✓ | ✓(cloud) | ✗ | OS-level via DEPLOY.md hardening | documented |

## 3. Self-evaluation — what we adopted (v0.9.0) and how

The pattern in every adoption: **map the feature onto CLAW's existing
seams** (the guard stack, the tool registry, the config layering) instead
of importing the original design.

### 3.1 Permission modes ← Claude Code permission modes + Codex sandboxes
- `--permission-mode plan` — every mutating tool (`shell`, `git_commit`,
  `write_file`, `edit_file`, `mkdir`) is denied with "present your complete
  plan as text"; read-only tools run freely. This is Claude Code's plan
  mode AND Devin's plan-first workflow.
- `--permission-mode acceptEdits` — file edits auto-run (they're already
  confined + secret-scanned); `shell`/`git_commit` still hit the human
  gate. Codex's "workspace-write" equivalent.
- `--permission-mode bypass` ≡ `--yolo`; `default` unchanged.
- Implemented inside `approvalGuard` (a ~20-line extension of the existing
  gate), exposed via config `permissionMode`, and switchable live in the
  REPL with `/mode plan | acceptEdits | default | bypass`.

### 3.2 User hooks ← Claude Code hooks
- Config: `"hooks": { "beforeTool": "...", "afterTool": "...", "onTurnEnd": "..." }`
  — shell commands receiving one JSON payload on stdin.
- `beforeTool` exit code **2 = veto** (the reason goes back to the model);
  other failures are non-blocking warnings, so a broken hook can't wedge
  the agent.
- Implemented as one more guard factory (`userHooksGuard`) appended to the
  existing stack — hooks ride the same 7 hook points, so they apply to
  sub-agents, the REPL, serve, and one-shot alike.

### 3.3 `todo_write` ← Claude Code TodoWrite
- The model maintains the session task list (full-replace semantics,
  `pending | in_progress | completed`), and every write returns the
  rendered checklist — which flows back into the context, keeping
  multi-step work on-plan.
- Devin's plan-file idea, in tool form.

### 3.4 Background shell ← Claude Code BashOutput + Codex
- `shell { cmd, background: true }` → returns a task id immediately (dev
  servers and long builds no longer block the loop or hit the 30s timeout).
- `task_output { task_id, wait_ms }` polls; `task_kill { task_id }`
  terminates and returns the transcript.

## 4. Rejected (for now), with reasons

| Feature | From | Why rejected |
| --- | --- | --- |
| Browser/computer-use tool | Devin | A browser automation stack is a second harness-sized project; `web_fetch` + `web_search` cover the read-only web. Revisit via MCP (a browser MCP server plugs in today). |
| OS-level sandbox (seccomp/Job objects) | Codex CLI | Real but platform-specific infrastructure; DEPLOY.md §6 documents the OS-level confinement (systemd `ProtectSystem`, containers) that achieves the same guarantee in production. |
| Checkpoint/rewind (Esc-Esc) | Claude Code | Requires file-system snapshotting UX; the git tools + worktrees give a composable version of the same safety. |
| Vision/image input | Claude Code | Requires multi-part content in the canonical message shape — a wire-format migration across all providers, not a feature bolt-on. |
| Pi's full extension API | Pi | CLAW's equivalent seams already exist: guards, hooks, custom commands, MCP servers, and CLAW.md. An arbitrary TypeScript extension loader would be a second way to do the same thing. |

## 5. What the comparison taught us

1. **Permission modes are the convergence point.** Every serious harness
   has *some* dial between "ask me everything" and "full auto" — Claude
   Code, Codex, and Devin all land on variants of read-only / edits-auto /
   full. CLAW now has that dial in ~20 lines because the approval gate was
   already a single choke point.
2. **Hooks are the escape hatch that keeps harnesses small.** Claude Code's
   hooks and Pi's extensions answer the same question: how do users inject
   policy without forking? Hooks + guards + MCP is CLAW's answer.
3. **The task list is disproportionately valuable.** It's trivial to build
   (one tool, one in-memory array) yet it's the feature most cited for
   keeping long agentic runs on track — because it writes the plan into
   the model's own context every turn.
4. **Minimal harnesses win on trust, opinionated ones on throughput.** CLAW
   sits deliberately in between: a small core (Pi's virtue) with the
   guard stack and observability built in (Claude Code's virtue).
