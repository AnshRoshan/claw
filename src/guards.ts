// guards.ts — the security spine. Mirrors the seven hook points from the
// architecture docs (guardrails.html): onTurnStart, beforeLLM, afterLLM,
// beforeTool, approveTool, afterTool, onTurnEnd. Each guard returns a verdict;
// the first non-"continue" verdict at a point wins. Order matters.

import { spawn } from "node:child_process";
import * as path from "node:path";
import type { ChatMsg, Guard, GuardCtx, GuardVerdict, ToolCall } from "./types.ts";
import { matchesAllowlist, parseJsonArgs, truncate } from "./util.ts";

/** Run guards registered at one hook point; first non-continue wins. */
export async function runPoint(
  guards: Guard[],
  point: Guard["point"],
  ctx: GuardCtx,
): Promise<GuardVerdict> {
  for (const g of guards) {
    if (g.point !== point) continue;
    const v = await g.check(ctx);
    if (v.action !== "continue") {
      v.message = v.message ?? `[${g.name}]`;
      return v;
    }
  }
  return { action: "continue" };
}

/** HOOK 1 — onTurnStart: refuse turns beyond a per-minute budget. */
export function rateLimitGuard(maxPerMinute: number): Guard {
  const stamps: number[] = [];
  return {
    point: "onTurnStart",
    name: "rate-limit",
    check() {
      const now = Date.now();
      while (stamps.length && now - stamps[0] > 60_000) stamps.shift();
      if (stamps.length >= maxPerMinute) {
        return { action: "deny", message: "rate limit hit — slow down and try again in a moment" };
      }
      stamps.push(now);
      return { action: "continue" };
    },
  };
}

/** HOOK 3 — afterLLM: abort when the model repeats the exact same call. */
export function loopDetectGuard(maxRepeats: number): Guard {
  const seen = new Map<string, number>();
  return {
    point: "afterLLM",
    name: "loop-detect",
    check(ctx) {
      const reply = ctx.messages[ctx.messages.length - 1];
      if (!reply || reply.role !== "assistant" || !reply.tool_calls?.length) return { action: "continue" };
      const sig = reply.tool_calls.map((t) => `${t.function.name}:${t.function.arguments}`).join("|");
      const n = (seen.get(sig) ?? 0) + 1;
      seen.set(sig, n);
      if (n > maxRepeats) {
        seen.clear();
        return {
          action: "abort",
          message: `the model repeated the same tool call ${n} times — stopping to avoid a runaway loop.`,
        };
      }
      return { action: "continue" };
    },
  };
}

/** HOOK 4 — beforeTool: file tools may never touch paths outside the workspace. */
export function pathConfineGuard(root: string): Guard {
  const abs = path.resolve(root);
  return {
    point: "beforeTool",
    name: "path-confine",
    check(ctx) {
      // Prefer explicit args; fall back to the args inside the tool call.
      const args =
        ctx.args ?? (ctx.call ? parseJsonArgs(ctx.call.function.arguments) : {});
      const p = args.path ?? args.pattern;
      if (typeof p !== "string" || p === "") return { action: "continue" };
      // Glob patterns contain wildcards — only enforce for plain paths.
      if (/[*?[\]{}]/.test(p)) return { action: "continue" };
      const resolved = path.resolve(abs, p);
      const rel = path.relative(abs, resolved);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        return {
          action: "deny",
          message: `path "${p}" escapes the workspace (${abs}) — denied`,
        };
      }
      return { action: "continue" };
    },
  };
}

/** HOOK 4 — beforeTool: allowlisted shell commands skip the approval gate. */
export function shellAllowlistGuard(allow: string[]): Guard {
  return {
    point: "beforeTool",
    name: "shell-allowlist",
    check(ctx) {
      if (ctx.call?.function.name !== "shell") return { action: "continue" };
      const args = ctx.args ?? (ctx.call ? parseJsonArgs(ctx.call.function.arguments) : {});
      const cmd = String(args.cmd ?? "");
      if (matchesAllowlist(cmd, allow)) return { action: "continue" };
      // Not allowlisted → the approval guard decides; mark it clearly.
      return {
        action: "modify",
        message: `"${truncate(cmd, 80)}" is not on the allowlist — requires approval`,
        args: ctx.args,
      };
    },
  };
}

/** File-mutating tools — what "plan mode" blocks and "acceptEdits" allows.
 *  delete_file is intentionally NOT here: it stays in riskyTools, so it is
 *  still gated in acceptEdits and blocked in plan (it is destructive). */
export const EDITING_TOOLS = ["write_file", "edit_file", "mkdir", "move_file"];

/** HOOK 5 — approveTool: the human gate, shaped by the permission mode.
 *  plan        → every mutating tool is denied; the model presents a plan
 *  default     → risky tools ask the human (allowlisted shell skips)
 *  acceptEdits → file edits auto-run; shell/git_commit still ask
 *  (bypassPermissions is autoApprove=true and is checked first) */
export function approvalGuard(
  riskyTools: string[],
  ask: (call: ToolCall) => Promise<boolean>,
  approveState: { autoApprove: boolean; dryRun?: boolean; mode?: "default" | "plan" | "acceptEdits" },
  shellAllowlist: string[] = [],
): Guard {
  return {
    point: "approveTool",
    name: "approval",
    check: async (ctx) => {
      if (approveState.autoApprove) return { action: "continue" };
      const name = ctx.call?.function.name ?? "";
      const mutating = riskyTools.includes(name) || (approveState.mode === "plan" && EDITING_TOOLS.includes(name));
      if (!mutating) return { action: "continue" };
      if (approveState.mode === "plan" && (riskyTools.includes(name) || EDITING_TOOLS.includes(name))) {
        return {
          action: "deny",
          message: `plan mode: ${name} was not executed. Explore, read, and think — then present your complete plan as text for approval. Do not call mutating tools.`,
        };
      }
      if (approveState.mode === "acceptEdits" && EDITING_TOOLS.includes(name)) {
        return { action: "continue" }; // edits are confined + secret-scanned anyway
      }
      // Dry-run: never execute risky tools — tell the model (and the trace)
      // exactly what WOULD have run, then continue the turn read-only.
      if (approveState.dryRun) {
        const args = ctx.args ?? parseJsonArgs(ctx.call?.function.arguments ?? "{}");
        return {
          action: "deny",
          message: `dry-run: ${name} was NOT executed. It would have run with args ${JSON.stringify(args).slice(0, 200)}. Continue planning without executing it.`,
        };
      }
      // Policy-approved commands (the shell allowlist) skip the human gate.
      if (name === "shell") {
        const args = ctx.args ?? parseJsonArgs(ctx.call?.function.arguments ?? "{}");
        if (matchesAllowlist(String(args.cmd ?? ""), shellAllowlist)) return { action: "continue" };
      }
      const ok = await ask(ctx.call!);
      if (!ok) {
        return { action: "deny", message: `user denied ${name} — explain what you were going to do and adapt` };
      }
      return { action: "continue" };
    },
  };
}

/** HOOK 6 — afterTool: cap oversized results so the model never drowns. */
export function outputCapGuard(maxChars: number): Guard {
  return {
    point: "afterTool",
    name: "output-cap",
    check(ctx) {
      const r = ctx.result ?? "";
      if (r.length > maxChars) {
        return { action: "modify", result: truncate(r, maxChars) + `\n…[truncated at ${maxChars} chars]` };
      }
      return { action: "continue" };
    },
  };
}

/** HOOK 6 — afterTool: redact credentials before the model sees them. */
export function secretScanGuard(): Guard {
  const patterns: Array<[RegExp, string]> = [
    [/sk-ant-[A-Za-z0-9_\-]{10,}/g, "sk-ant-***"],
    [/sk-[A-Za-z0-9]{20,}/g, "sk-***"],
    [/ghp_[A-Za-z0-9]{20,}/g, "ghp_***"],
    [/AKIA[0-9A-Z]{16}/g, "AKIA***"],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, "-----BEGIN PRIVATE KEY-----***"],
    [/(api[_-]?key|token|password|secret)\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{8,}/gi, "$1=***"],
  ];
  return {
    point: "afterTool",
    name: "secret-scan",
    check(ctx) {
      let r = ctx.result ?? "";
      let changed = false;
      for (const [re, sub] of patterns) {
        if (re.test(r)) {
          r = r.replace(re, sub);
          changed = true;
        }
      }
      return changed ? { action: "modify", result: r } : { action: "continue" };
    },
  };
}

/** HOOK 7 — onTurnEnd: final scrub before the answer reaches the human. */
export function turnEndSanitizeGuard(): Guard {
  const inner = secretScanGuard();
  return {
    point: "onTurnEnd",
    name: "turn-end-sanitize",
    check(ctx) {
      const v = inner.check(ctx);
      return v;
    },
  };
}

/** User hooks (the Claude Code hooks feature): config-defined shell commands
 *  that observe — and can veto — tool calls. The hook receives one JSON
 *  payload on stdin:
 *    beforeTool  { call: { name, arguments }, sessionKey }   exit 2 = DENY
 *    afterTool   { call: { name, arguments }, result, sessionKey }
 *    onTurnEnd   { answer, sessionKey }
 *  A failing/misbehaving hook is a warning, not a crash — except an explicit
 *  exit 2 on beforeTool, which is the veto signal. */
export interface HookCommands {
  beforeTool?: string;
  afterTool?: string;
  onTurnEnd?: string;
}

function runHook(cwd: string, cmd: string, payload: unknown, timeoutMs = 10_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const child = spawn(isWin ? "cmd.exe" : "/bin/sh", isWin ? ["/d", "/s", "/c", cmd] : ["-c", cmd], {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 2000) });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(124);
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", () => {
      clearTimeout(timer);
      finish(127);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code ?? 1);
    });
    child.stdin?.end(JSON.stringify(payload));
  });
}

export function userHooksGuard(cfg: { workspace: string; hooks: HookCommands }): Guard[] {
  const cwd = cfg.workspace;
  const out: Guard[] = [];

  if (cfg.hooks.beforeTool) {
    out.push({
      point: "beforeTool",
      name: "hook-beforeTool",
      check: async (ctx) => {
        const r = await runHook(cwd, cfg.hooks.beforeTool!, {
          call: { name: ctx.call?.function.name, arguments: ctx.args ?? {} },
          sessionKey: ctx.sessionKey,
        });
        if (r.code === 2) {
          return { action: "deny", message: `blocked by beforeTool hook: ${r.stderr.trim() || r.stdout.trim() || "(exit 2)"}` };
        }
        if (r.code !== 0) {
          return { action: "continue", message: `[beforeTool hook exited ${r.code} — non-blocking]` };
        }
        return { action: "continue" };
      },
    });
  }

  if (cfg.hooks.afterTool) {
    out.push({
      point: "afterTool",
      name: "hook-afterTool",
      check: async (ctx) => {
        const r = await runHook(cwd, cfg.hooks.afterTool!, {
          call: { name: ctx.call?.function.name, arguments: ctx.args ?? {} },
          result: ctx.result,
          sessionKey: ctx.sessionKey,
        });
        if (r.code !== 0) {
          return { action: "continue", result: (ctx.result ?? "") + `
[afterTool hook flagged this (exit ${r.code})]` };
        }
        return { action: "continue" };
      },
    });
  }

  if (cfg.hooks.onTurnEnd) {
    out.push({
      point: "onTurnEnd",
      name: "hook-onTurnEnd",
      check: async (ctx) => {
        const r = await runHook(cwd, cfg.hooks.onTurnEnd!, { answer: ctx.result, sessionKey: ctx.sessionKey });
        if (r.code !== 0) {
          return { action: "continue", result: (ctx.result ?? "") + `
[onTurnEnd hook flagged this answer (exit ${r.code})]` };
        }
        return { action: "continue" };
      },
    });
  }

  return out;
}

/** Convenience: the default guard stack, in the cheapest-first order. */
export function defaultGuards(
  cfg: { workspace: string; shellAllowlist: string[]; riskyTools: string[]; outputCap: number; hooks?: HookCommands },
  ask: (call: ToolCall) => Promise<boolean>,
  approveState: { autoApprove: boolean; dryRun?: boolean; mode?: "default" | "plan" | "acceptEdits" },
): Guard[] {
  return [
    rateLimitGuard(30),
    loopDetectGuard(3),
    pathConfineGuard(cfg.workspace),
    shellAllowlistGuard(cfg.shellAllowlist),
    approvalGuard(cfg.riskyTools, ask, approveState, cfg.shellAllowlist),
    outputCapGuard(cfg.outputCap),
    secretScanGuard(),
    turnEndSanitizeGuard(),
    ...(cfg.hooks ? userHooksGuard({ workspace: cfg.workspace, hooks: cfg.hooks }) : []),
  ];
}

export type { ChatMsg, GuardCtx };
