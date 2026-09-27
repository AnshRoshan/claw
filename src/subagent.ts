// subagent.ts — agent-to-agent handoff. The `delegate` tool spawns fresh,
// isolated sub-agents with their own conversation, tool set, and guards; when
// each sub-agent finishes (or its timeout aborts it), its session lock is
// released, its token usage is merged into the parent ledger, and the parent
// receives a structured receipt with the final answer. Delegation is
// recursive (sub-agents may delegate) up to a depth limit, and every workflow
// closes cleanly: aborting a sub-agent aborts its in-flight provider calls
// via AbortSignal.
//
// `delegate` takes ONE task. `delegate` with a `tasks: [...]` array fans out
// to N sub-agents concurrently (bounded by subagents.maxConcurrency) and
// merges all receipts — the parallel fan-out from the architecture docs.

import type { ChatMsg, Guard, Provider, Tool } from "./types.ts";
import { Agent } from "./agent.ts";
import { Ledger } from "./cost.ts";
import { createWorktree, type Worktree } from "./tools/git.ts";

export interface DelegateCtx {
  /** How deep this chain already is (0 = top-level agent). */
  depth: number;
  maxDepth: number;
  /** Counter for sub-agent ids and session keys — mutated as children spawn. */
  counter: number;
  /** The parent session key — sub-agents derive `sub:<parent>:<n>`. */
  parentKey: string;
  /** The parent's ledger — the sub-agent's usage merges into it on close. */
  ledger: Ledger;
}

export interface DelegateOpts {
  provider: Provider;
  /** Full tool list INCLUDING the delegate tool (rebuilt for the child). */
  makeToolset: (ctx: DelegateCtx) => Tool[];
  guards: Guard[];
  maxDepth: number;
  timeoutMs: number;
  maxIterations: number;
  compactAt: number;
  verbose: boolean;
  workspace: string;
  /** Max sub-agents running at once for a parallel fan-out. */
  maxConcurrency?: number;
  /** Give each parallel task its own git worktree (branch `claw/<id>`) so
   * file edits never collide. Branches are left for human review/merge. */
  worktree?: boolean;
  /** Token ceiling per sub-agent — the child aborts with an explicit
   * message before crossing it (mirrors the parent's runaway guards). */
  budget?: { maxInputTokens?: number; maxOutputTokens?: number };
  /** Live event hook (the parent's trace line sink) for sub-agent lifecycle. */
  notify?: (s: string) => void;
}

/** Run one delegated task on a fresh, isolated sub-agent. Returns the receipt. */
async function runSubAgent(
  opts: DelegateOpts,
  ctx: DelegateCtx,
  id: number,
  task: string,
  timeoutArg: unknown,
  worktree?: Worktree,
): Promise<string> {
  // Fresh, isolated sub-agent: own conversation, own ledger, own lock.
  const ac = new AbortController();
  const timeout = Number(timeoutArg) > 0 ? Number(timeoutArg) : opts.timeoutMs;
  const timer = setTimeout(() => ac.abort(), timeout);
  const subLedger = new Ledger();
  const childCtx: DelegateCtx = {
    depth: ctx.depth + 1,
    maxDepth: opts.maxDepth,
    counter: id,
    parentKey: ctx.parentKey,
    ledger: subLedger,
  };
  const workspace = worktree?.path ?? opts.workspace;
  opts.notify?.(
    `  ⋮ sub-agent #${id} spawning (depth ${ctx.depth + 1}/${opts.maxDepth})${worktree ? ` in worktree ${worktree.branch}` : ""}`,
  );
  const subAgent = new Agent(
    opts.provider,
    opts.makeToolset(childCtx),
    {
      maxIterations: opts.maxIterations,
      verbose: opts.verbose,
      compactAt: opts.compactAt,
      log: () => {}, // sub-agent keeps its own silence; the receipt speaks
      onText: () => {},
      signal: ac.signal,
      budget: opts.budget,
    },
    subLedger,
  ).use(...opts.guards);

  const history: ChatMsg[] = [
    {
      role: "system",
      content:
        Agent.systemPrompt(workspace) +
        (worktree
          ? `\n\nYou are working in an ISOLATED GIT WORKTREE on branch ${worktree.branch}. Commit your work here; the human will merge.`
          : "") +
        "\n\nYou are a SUB-AGENT handling exactly one delegated task. Stay on task. Use your tools as needed, then answer with the final result. You may delegate sub-sub-tasks only if you must, but prefer finishing yourself.",
    },
    { role: "user", content: task },
  ];

  try {
    try {
      const outcome = await subAgent.runTurn(`sub:${ctx.parentKey}:${id}`, history);
      // ── CLOSE the workflow: merge costs into the parent, release the
      //    sub-agent's session lock (runTurn's finally), report. ──
      ctx.ledger.merge(subAgent.ledger);
      const status = outcome.aborted ? "aborted" : "complete";
      opts.notify?.(`  ⋮ sub-agent #${id} ${status}`);
      const answer = outcome.answer.replace(/\s+$/, "");
      return (
        `[sub-agent #${id} ${status}, ${subAgent.ledger.totals.calls} call(s)]\n` +
        answer +
        (worktree ? `\n[work: on branch ${worktree.branch} in ${worktree.path} — left for review/merge]` : "") +
        `\n[sub-agent #${id} end]`
      );
    } catch (err) {
      // One failed sub-agent must not sink a parallel fan-out.
      opts.notify?.(`  ⋮ sub-agent #${id} failed: ${(err as Error).message}`);
      return `[sub-agent #${id} error] ${(err as Error).message}\n[sub-agent #${id} end]`;
    }
  } finally {
    clearTimeout(timer);
    ac.abort(); // ensure nothing lingers
  }
}

export function makeDelegateTool(opts: DelegateOpts, ctx: DelegateCtx): Tool {
  return {
    name: "delegate",
    description:
      "Delegate work to sub-agent(s) and wait for their results. Pass `task` (string) for ONE sub-agent, or `tasks` (array of strings) to fan out to several sub-agents IN PARALLEL — use for independent pieces of work (research, self-contained features, focused investigations). Sub-agents have the same tools and guards. Pass each task as a precise, self-sufficient instruction. Results return as text receipts, one per task.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "The exact task for one sub-agent." },
        tasks: {
          type: "array",
          items: { type: "string" },
          description: "Several independent tasks — one sub-agent each, run in parallel (bounded).",
        },
        timeout_ms: { type: "number", description: "Optional per-sub-agent timeout in milliseconds." },
      },
      required: [],
    },
    risk: "safe",
    cacheable: false,
    async execute(args) {
      const single = String(args.task ?? "").trim();
      const list = Array.isArray(args.tasks)
        ? args.tasks.map((t) => String(t ?? "").trim()).filter(Boolean)
        : [];
      const tasks = single && list.length ? [single, ...list] : list.length ? list : [single];
      if (!tasks[0]) throw new Error("delegate needs a task (or a tasks array)");

      if (ctx.depth >= opts.maxDepth) {
        throw new Error(
          `delegation depth limit (${opts.maxDepth}) reached — do not delegate further; handle this yourself: ${tasks[0].slice(0, 200)}`,
        );
      }

      if (tasks.length === 1) {
        const id = ctx.counter + 1;
        ctx.counter = id;
        return await runSubAgent(opts, ctx, id, tasks[0], args.timeout_ms);
      }

      // ── Parallel fan-out with bounded concurrency: `maxConcurrent` worker
      //    loops each run one sub-agent AT A TIME until the queue drains. ──
      const maxConcurrent = Math.max(1, Math.min(opts.maxConcurrency ?? 4, tasks.length));
      opts.notify?.(`  ⋮ delegating ${tasks.length} tasks in parallel (max ${maxConcurrent} at a time)`);

      // Optional isolation: one git worktree per task so parallel file
      // edits never collide. Branches stay behind for human review/merge.
      const worktrees: Array<Worktree | undefined> = new Array(tasks.length).fill(undefined);
      if (opts.worktree) {
        for (let i = 0; i < tasks.length; i++) {
          const wt = await createWorktree(opts.workspace, `task-${i + 1}-${Date.now().toString(36)}`);
          if (wt) {
            worktrees[i] = wt;
            opts.notify?.(`  ⋮ worktree ${wt.branch} → ${wt.path}`);
          } else {
            opts.notify?.(`  ⋮ worktree unavailable for task ${i + 1} — sharing the workspace instead`);
          }
        }
      }

      const parts: string[] = new Array(tasks.length);
      let next = ctx.counter;
      const queue = tasks.map((task, i) => ({ task, i }));
      const workers = Array.from({ length: maxConcurrent }, async () => {
        for (;;) {
          const item = queue.shift();
          if (!item) return;
          const id = ++next;
          parts[item.i] = await runSubAgent(opts, ctx, id, item.task, args.timeout_ms, worktrees[item.i]);
        }
      });
      await Promise.all(workers);
      ctx.counter = next;

      // Receipts land in the CALLER'S task order, regardless of completion order.
      return parts.join("\n\n");
    },
  };
}
