// agent.ts — the TAOR loop (Think → Act → Observe → Repeat), the inner loop
// of every claw. Same spine as claw-orchestrator: Provider + Tools + Guards +
// a session lock + an iteration cap, plus the two caches (whole-turn response
// cache and idempotent tool-result cache) and history compaction.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir, platform, release } from "node:os";
import type { ChatMsg, Guard, GuardCtx, Provider, Tool, ToolCall, Usage } from "./types.ts";
import { runPoint } from "./guards.ts";
import { Ledger } from "./cost.ts";
import { parseJsonArgs, truncate } from "./util.ts";

/** First file that exists and reads cleanly, or null. */
function readFirst(paths: string[]): string | null {
  for (const p of paths) {
    try {
      const text = fs.readFileSync(p, "utf8").trim();
      if (text) return text;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

export interface TurnOutcome {
  answer: string;
  history: ChatMsg[];
  usage: Usage[];
  toolCallsMade: number;
  aborted: boolean;
}

export interface AgentOpts {
  maxIterations: number;
  verbose: boolean;
  compactAt: number;
  /** Called with live trace lines and streamed text deltas. */
  log: (s: string) => void;
  /** Called with assistant text deltas as they stream in. */
  onText?: (d: string) => void;
  /** Abort the whole turn (used to close sub-agent workflows on timeout). */
  signal?: AbortSignal;
  /** Token ceiling for THIS agent (its own ledger). Crossing it mid-turn
   * stops the loop with an explicit message — the budget runaway guard. */
  budget?: { maxInputTokens?: number; maxOutputTokens?: number };
}

/** Emitted around every tool execution so channels can show live traces. */
export interface ToolTraceEvent {
  kind: "tool-start" | "tool-end";
  name: string;
  detail: string;
  ok: boolean;
  /** tool-end only: execution duration in milliseconds. */
  ms?: number;
  /** Untruncated payload (args at start, result at end), capped — for
   * inspectors that want to show the whole exchange, DevTools-style. */
  full?: string;
}

const cacheTtl = 10 * 60_000; // 10 minutes

function hash(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 16);
}

export class Agent {
  private tools = new Map<string, Tool>();
  private toolDefs;
  private guards: Guard[] = [];
  private active = new Set<string>(); // session lock
  private respCache = new Map<string, { t: number; answer: string }>();
  private toolCache = new Map<string, { t: number; result: string }>();
  /** Memoized LLM summaries, keyed by the hash of the dropped prefix. */
  private summaryCache = new Map<string, string>();
  readonly ledger: Ledger;

  /** The active model — swappable at runtime (/model). */
  provider: Provider;
  readonly opts: AgentOpts;

  constructor(
    provider: Provider,
    tools: Tool[],
    opts: AgentOpts,
    /** Inject a shared ledger (sub-agents merge into the parent's). */
    ledger: Ledger = new Ledger(),
  ) {
    this.provider = provider;
    this.opts = opts;
    this.ledger = ledger;
    for (const t of tools) this.tools.set(t.name, t);
    this.toolDefs = tools.map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  use(...guards: Guard[]): this {
    this.guards.push(...guards);
    return this;
  }

  /** Swap the model mid-session (/model command). History survives. */
  swapProvider(p: Provider): void {
    this.provider = p;
  }

  /** Shrink a history list: keep the system message + the most recent N. */
  static compact(history: ChatMsg[], keep: number): ChatMsg[] {
    if (history.length <= keep) return history;
    const out = [history[0]];
    out.push(...history.slice(-(keep - 1)));
    return out;
  }

  /**
   * Summarize a whole session for later resumption (the "summarize-on-close"
   * feature). One no-tools call; returns null if the provider fails or the
   * history is too short to be worth it. The result is stored in the
   * session's JSONL header by the channel (repl.ts) and re-injected by
   * `claw continue`.
   */
  static async summarizeSession(
    provider: Provider,
    history: ChatMsg[],
    signal?: AbortSignal,
  ): Promise<string | null> {
    const meaningful = history.filter((m) => m.role !== "system");
    if (meaningful.length < 4) return null;
    const transcript = meaningful
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n\n")
      .slice(0, 40_000);
    try {
      const res = await provider.chat(
        [
          {
            role: "user",
            content:
              "Summarize this coding-agent session for later resumption. Preserve: the user's goals, what was done (files touched, commands run and outcomes), decisions made, and exactly what remains to be done next. Plain prose, under 250 words.\n\n---\n\n" +
              transcript,
          },
        ],
        [],
        { signal },
      );
      const text = res.content.trim();
      return text || null;
    } catch {
      return null; // summarization is best-effort; never block exit
    }
  }

  /** System prompt injected at the top of every session. */
  static systemPrompt(workspace: string): string {
    const env = [
      `Runtime: ${platform()} ${release()} · Node ${process.version}`,
      `Date: ${new Date().toISOString().slice(0, 10)}`,
      `Project folder: ${path.basename(path.resolve(workspace))} (${workspace})`,
    ].join(" · ");
    return [
      "You are CLAW, a capable terminal coding agent.",
      `You work inside the workspace folder: ${workspace}`,
      `Environment: ${env}.`,
      "You have tools to read, search, edit, and run commands in that folder, and to fetch web pages.",
      "Rules:",
      "  - Inspect files before editing them; use read_file / grep / glob first.",
      "  - read_file output is line-numbered ('N\\tcode'). When editing, copy text WITHOUT the numbers.",
      "  - For multi-file work, write files one at a time and verify with list_dir / glob.",
      "  - Independent read-only lookups (read/grep/glob) may be requested together — they run in parallel.",
      "  - Keep prose short and do the work. Show code in ``` fences.",
      "  - Never claim a command ran unless you actually ran it via the shell tool.",
      "  - If a tool fails, read the error and adapt — do not repeat the same call.",
      "  - Do not attempt to modify anything outside the workspace.",
      Agent.instructionsBlock(workspace),
    ].filter(Boolean).join("\n");
  }

  /**
   * Project instructions: CLAW.md (or AGENTS.md) in the workspace, falling
   * back to ~/.claw/CLAW.md. Teams drop conventions into CLAW.md and every
   * session — REPL, one-shot, serve — obeys them. Missing file → empty.
   */
  static instructionsBlock(workspace: string): string {
    const text = readFirst([
      path.join(workspace, "CLAW.md"),
      path.join(workspace, "AGENTS.md"),
      path.join(homedir(), ".claw", "CLAW.md"),
    ]);
    if (!text) return "";
    return [
      "",
      "PROJECT INSTRUCTIONS (from the workspace's CLAW.md — follow them):",
      text.slice(0, 8_000),
    ].join("\n");
  }

  private async guardAt(point: Guard["point"], ctx: GuardCtx) {
    return runPoint(this.guards, point, ctx);
  }

  /**
   * Run one full turn: reason until the model answers with text or the
   * iteration cap trips. Returns the final answer and the new history.
   * `turnOpts.onText` overrides the agent-level sink for THIS turn only —
   * that's what lets the HTTP channel stream deltas per request without
   * concurrent sessions interleaving into each other.
   */
  async runTurn(
    sessionKey: string,
    history: ChatMsg[],
    turnOpts?: {
      onText?: (d: string) => void;
      onReasoning?: (d: string) => void;
      onEvent?: (e: ToolTraceEvent) => void;
    },
  ): Promise<TurnOutcome> {
    const log = this.opts.log;
    const usage: Usage[] = [];

    // ── Session lock ──
    if (this.active.has(sessionKey)) {
      return {
        answer: "[a turn is already running for this session — try again in a moment]",
        history,
        usage,
        toolCallsMade: 0,
        aborted: true,
      };
    }
    this.active.add(sessionKey);
    try {
      return await this.runTurnInner(sessionKey, history, usage, log, turnOpts);
    } finally {
      this.active.delete(sessionKey);
    }
  }

  private async runTurnInner(
    sessionKey: string,
    history: ChatMsg[],
    usage: Usage[],
    log: (s: string) => void,
    turnOpts?: {
      onText?: (d: string) => void;
      onReasoning?: (d: string) => void;
      onEvent?: (e: ToolTraceEvent) => void;
    },
  ): Promise<TurnOutcome> {
    const turnOnText = turnOpts?.onText;
    const turnOnReasoning = turnOpts?.onReasoning;
    const onEvent = turnOpts?.onEvent;
    // Trace lines go through `log`; the Screen flushes the stream panel first,
    // so trace lines never glue onto streamed text. Markers drive styling:
    // ⚙ think · ▶ act · ◀ observe · ✗ error · ! failure · ⚡ cache · ↻ compact
    // · usage · ⋮ sub-agent events.
    const trace = (s: string) => log(s);

    // ── HOOK 1: onTurnStart ──
    const start = await this.guardAt("onTurnStart", { sessionKey, messages: history });
    if (start.action !== "continue") return this.finish(start.message ?? "denied", history, usage, true, 0);

    // ── CACHE: exact-repeat turn costs zero LLM calls ──
    const turnKey = hash(JSON.stringify(history));
    const cached = this.respCache.get(turnKey);
    if (cached && Date.now() - cached.t < cacheTtl) {
      trace("  ⚡ response cache hit — 0 LLM calls");
      return this.finish(cached.answer, [...history, { role: "assistant", content: cached.answer }], usage, false, 0);
    }

    const sessionCtx = (iter: number, extra: Partial<GuardCtx> = {}): GuardCtx => ({
      sessionKey,
      messages: history,
      iteration: iter,
      ...extra,
    });

    let toolCallsMade = 0;
    for (let i = 1; i <= this.opts.maxIterations; i++) {
      // Sub-agent shutdown: a parent abort stops the loop between iterations.
      if (this.opts.signal?.aborted) {
        return this.finish("[aborted]", history, usage, true, toolCallsMade);
      }

      // Budget runaway guard: stop before crossing the token ceiling.
      const budget = this.opts.budget;
      if (budget) {
        const t = this.ledger.totals;
        const overIn = budget.maxInputTokens !== undefined && t.input >= budget.maxInputTokens;
        const overOut = budget.maxOutputTokens !== undefined && t.output >= budget.maxOutputTokens;
        if (overIn || overOut) {
          const what = overIn ? `input ${t.input}/${budget.maxInputTokens}` : `output ${t.output}/${budget.maxOutputTokens}`;
          return this.finish(`[budget exceeded: ${what} tokens — stopping to protect the spend]`, history, usage, true, toolCallsMade);
        }
      }

      // ── HOOK 2: beforeLLM ──
      const pre = await this.guardAt("beforeLLM", sessionCtx(i));
      if (pre.action === "abort") return this.finish(pre.message ?? "aborted", history, usage, true, toolCallsMade);

      // ── THINK ──
      const toSend = await this.maybeCompact(history, trace);
      if (this.opts.verbose) {
        trace(`  ⚙ ${i}/${this.opts.maxIterations} · ${this.provider.name} / ${this.provider.model}`);
      }

      let reply: Awaited<ReturnType<Provider["chat"]>>;
      try {
        reply = await this.provider.chat(toSend, this.toolDefs, {
          onText: (d) => (turnOnText ?? this.opts.onText)?.(d),
          onReasoning: (d) => turnOnReasoning?.(d),
          signal: this.opts.signal,
        });
      } catch (err) {
        const msg = (err as Error).message;
        trace(`  ! provider error: ${msg}`);
        return this.finish(`[provider error: ${msg}]`, history, usage, true, toolCallsMade);
      }
      if (reply.usage) usage.push(reply.usage);
      this.ledger.add(reply.usage);
      history.push({ role: "assistant", content: reply.content, tool_calls: reply.toolCalls.length ? reply.toolCalls : undefined });
      if (this.opts.verbose) trace(`  · usage ${usageReport(reply.usage)}`);

      // ── HOOK 3: afterLLM — loop detection / malformed call repair ──
      const after = await this.guardAt("afterLLM", sessionCtx(i));
      if (after.action === "abort") return this.finish(after.message ?? "aborted", history, usage, true, toolCallsMade);

      // No tool calls → the model is done. The loop's only happy exit.
      if (!reply.toolCalls.length) {
        const out = await this.hookTurnEnd(sessionKey, history, reply.content);
        this.respCache.set(turnKey, { t: Date.now(), answer: out });
        return this.finish(out, history, usage, false, toolCallsMade);
      }

      // ── ACT ──
      // Mutating/risky tools run one at a time (sequential, like the
      // orchestrator). Maximal RUNS of consecutive read-only tools run
      // concurrently — the model's parallel lookups are honoured.
      const calls = reply.toolCalls;
      let ci = 0;
      while (ci < calls.length) {
        const tc = calls[ci];
        const isRead = this.tools.get(tc.function.name)?.risk === "read";
        let end = ci;
        if (isRead) {
          while (end < calls.length && this.tools.get(calls[end].function.name)?.risk === "read") end++;
        }
        if (end - ci > 1) {
          const run = calls.slice(ci, end);
          if (this.opts.verbose) {
            trace(`  ⚡ parallel batch: ${run.length} read-only calls`);
          }
          const results = await Promise.all(
            run.map((r) => {
              toolCallsMade++;
              return this.guardedCall(r, i, trace, onEvent, sessionKey, history);
            }),
          );
          for (let k = 0; k < run.length; k++) {
            history.push({ role: "tool", tool_call_id: run[k].id, content: results[k] });
          }
          ci = end;
          continue;
        }
        toolCallsMade++;
        const result = await this.guardedCall(tc, i, trace, onEvent, sessionKey, history);
        history.push({ role: "tool", tool_call_id: tc.id, content: result });
        ci++;
      }
    }

    // Iteration cap hit — the runaway guard.
    return this.finish(
      `[reached ${this.opts.maxIterations} iterations without a final answer — stopping to avoid a runaway loop]`,
      history,
      usage,
      true,
      toolCallsMade,
    );
  }

  /** One tool call, all guard hooks around it, result text out. */
  private async guardedCall(
    tc: ToolCall,
    iter: number,
    trace: (s: string) => void,
    onEvent: ((e: ToolTraceEvent) => void) | undefined,
    sessionKey: string,
    history: ChatMsg[],
  ): Promise<string> {
    const log = this.opts.log;
    const { name, arguments: rawArgs } = tc.function;
    const args = parseJsonArgs(rawArgs);
    if (this.opts.verbose) trace(`  ▶ ${name} ${truncate(rawArgs, 110)}`);
    const toolT0 = Date.now();
    onEvent?.({ kind: "tool-start", name, detail: truncate(rawArgs, 100), ok: true, full: capFull(rawArgs) });
    const ctx: GuardCtx = { sessionKey, messages: history, iteration: iter, call: tc, args };

    // ── HOOK 4: beforeTool ──
    const before = await this.guardAt("beforeTool", ctx);
    let result: string;
    switch (before.action) {
      case "deny":
        result = `denied by guard: ${before.message}`;
        break;
      case "respond":
        result = before.message ?? "(no response)";
        break;
      default:
        // "continue" and "modify" (shell-allowlist flag) fall through to the gate
        result = "";
    }

    if (result === "") {
      // ── HOOK 5: approveTool — the human gate ──
      const approve = await this.guardAt("approveTool", ctx);
      if (approve.action === "deny") {
        result = approve.message ?? `user denied ${name}`;
      } else if (approve.action === "respond") {
        result = approve.message ?? "(no response)";
      } else {
        result = await this.executeTool(tc, args, log);
      }
    }

    // ── HOOK 6: afterTool — output cap + secret scan ──
    const afterTool = await this.guardAt("afterTool", { ...ctx, result });
    if (afterTool.action === "modify" && afterTool.result !== undefined) result = afterTool.result;

    const bad = result.startsWith("error") || result.startsWith("denied");
    onEvent?.({ kind: "tool-end", name, detail: truncate(result, 140), ok: !bad, ms: Date.now() - toolT0, full: capFull(result) });
    if (this.opts.verbose) {
      trace(`  ${bad ? "✗" : "◀"} ${truncate(result, 130)}`);
    }
    return result;
  }

  private async executeTool(tc: ToolCall, args: Record<string, unknown>, log: (s: string) => void): Promise<string> {
    const tool = this.tools.get(tc.function.name);
    if (!tool) return `error: no such tool "${tc.function.name}"`;

    // ── CACHE: idempotent tools only ──
    if (tool.cacheable) {
      const key = hash(`${tc.function.name}:${JSON.stringify(args)}`);
      const hit = this.toolCache.get(key);
      if (hit && Date.now() - hit.t < cacheTtl) {
        log("  ⚡ tool cache hit — skipped execution");
        return hit.result;
      }
      try {
        const out = await tool.execute(args);
        this.toolCache.set(key, { t: Date.now(), result: out });
        return out;
      } catch (err) {
        return `error: ${(err as Error).message}`;
      }
    }

    try {
      return await tool.execute(args);
    } catch (err) {
      return `error: ${(err as Error).message}`;
    }
  }

  /** HOOK 7: onTurnEnd — final scrub of the answer. */
  private async hookTurnEnd(sessionKey: string, history: ChatMsg[], answer: string): Promise<string> {
    const v = await this.guardAt("onTurnEnd", { sessionKey, messages: history, result: answer });
    return v.action === "modify" && v.result !== undefined ? v.result : answer;
  }

  /**
   * Compaction: when history grows past compactAt messages, summarize the
   * older messages WITH THE MODEL (one no-tools call, memoized per prefix)
   * and replace them with a compact summary. Keeps the system prompt and the
   * most recent window verbatim. If the model call fails, fall back to plain
   * truncation — compaction must never lose the turn.
   */
  private async maybeCompact(history: ChatMsg[], log: (s: string) => void): Promise<ChatMsg[]> {
    if (history.length <= this.opts.compactAt) return history;
    const keep = this.opts.compactAt - 2;
    const recent = history.slice(-(keep - 1));
    const droppable = history.slice(1, history.length - recent.length);
    // Not enough substance to be worth a model call — just truncate.
    if (droppable.length < 4) return Agent.compact(history, keep);

    const key = hash(JSON.stringify(droppable));
    let summary = this.summaryCache.get(key);
    if (summary === undefined) {
      const transcript = droppable
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n\n")
        .slice(0, 60_000);
      try {
        const res = await this.provider.chat(
          [
            {
              role: "user",
              content:
                "Summarize this excerpt of an agent conversation for continued work. Preserve: the user's goals, decisions made, file paths touched, commands run and their outcomes, and any open threads. Be concise — plain prose or short bullets, under 300 words.\n\n---\n\n" +
                transcript,
            },
          ],
          [],
          { signal: this.opts.signal },
        );
        this.ledger.add(res.usage);
        summary = res.content.trim() || "(empty summary)";
        this.summaryCache.set(key, summary);
        log(`  ↻ summarized ${droppable.length} old messages with the model`);
      } catch (err) {
        log(`  ↻ summarization failed (${(err as Error).message}) — truncating instead`);
        return Agent.compact(history, keep);
      }
    } else {
      log(`  ↻ reusing conversation summary (${droppable.length} old messages)`);
    }
    return [history[0], { role: "system", content: `[Summary of the earlier conversation]\n${summary}` }, ...recent];
  }


  private finish(
    answer: string,
    history: ChatMsg[],
    usage: Usage[],
    aborted: boolean,
    toolCallsMade: number,
  ): TurnOutcome {
    return { answer, history, usage, toolCallsMade, aborted };
  }
}

/** Cap a trace event's full payload so SSE frames stay bounded. */
function capFull(s: string): string {
  return s.length > 8_000 ? s.slice(0, 8_000) + "\n…[capped at 8k chars]" : s;
}

function usageReport(u: Usage | null): string {  if (!u) return "no usage reported";
  const parts = [`in ${u.inputTokens}`, `out ${u.outputTokens}`];
  if (u.cacheReadTokens) parts.push(`cached ${u.cacheReadTokens}`);
  return parts.join(" · ");
}
