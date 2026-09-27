// tools/shell.ts — run a shell command in the workspace. This is the most
// powerful tool and therefore the riskiest: it is marked "risky" and goes
// through the human approval gate unless the command is on the allowlist or
// --yolo / autoApprove is set.
//
// Background execution (the Claude Code BashOutput pattern): shell with
// `background: true` returns a task id immediately; `task_output` polls it
// (optionally waiting), `task_kill` terminates it. Long builds and dev
// servers no longer block the loop or hit the 30s timeout.

import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { newId } from "../util.ts";
import type { Tool } from "../types.ts";

const MAX_OUTPUT = 10_000;
const TIMEOUT_MS = 30_000;

interface BgTask {
  id: string;
  cmd: string;
  child: ChildProcess;
  out: string;
  done: boolean;
  code: number | null;
  startedAt: number;
}

/** Background task registry, shared by the three task tools. */
export const bgTasks = new Map<string, BgTask>();

function spawnShell(cwd: string, cmd: string): ChildProcess {
  const isWin = process.platform === "win32";
  const shell = isWin ? "cmd.exe" : "/bin/sh";
  const shellArgs = isWin ? ["/d", "/s", "/c", cmd] : ["-c", cmd];
  return spawn(shell, shellArgs, {
    cwd,
    windowsHide: true,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function statusLine(t: BgTask): string {
  const secs = ((Date.now() - t.startedAt) / 1000).toFixed(1);
  const state = t.done ? (t.code === 0 ? "completed" : `failed (exit ${t.code})`) : "running";
  return `[task ${t.id}] ${state} after ${secs}s — ${t.cmd.slice(0, 80)}`;
}

export function makeShellTools(root: string): Tool[] {
  const cwd = path.resolve(root);

  const shell: Tool = {
    name: "shell",
    description:
      "Run a shell command inside the workspace and return its stdout+stderr. Non-allowlisted commands require your approval. Use for builds, tests, git status, package installs, etc. For long-running commands (dev servers, big builds, test suites), pass background=true — you get a task id immediately; poll it with task_output.",
    parameters: {
      type: "object",
      properties: {
        cmd: { type: "string", description: "The command to run, e.g. 'npm test'." },
        background: { type: "boolean", description: "Run detached and return a task id immediately." },
      },
      required: ["cmd"],
    },
    risk: "risky",
    cacheable: false,
    async execute(args) {
      const cmd = String(args.cmd ?? "");
      if (!cmd.trim()) throw new Error("empty command");

      if (args.background === true) {
        const child = spawnShell(cwd, cmd);
        const id = newId("task");
        const task: BgTask = { id, cmd, child, out: "", done: false, code: null, startedAt: Date.now() };
        child.stdout?.on("data", (d: Buffer) => {
          task.out += d.toString();
          if (task.out.length > MAX_OUTPUT * 2) task.out = task.out.slice(-MAX_OUTPUT);
        });
        child.stderr?.on("data", (d: Buffer) => {
          task.out += d.toString();
          if (task.out.length > MAX_OUTPUT * 2) task.out = task.out.slice(-MAX_OUTPUT);
        });
        child.on("error", (err) => {
          task.out += `\n[failed to start: ${err.message}]`;
          task.done = true;
          task.code = -1;
        });
        child.on("close", (code) => {
          task.done = true;
          task.code = code;
        });
        bgTasks.set(id, task);
        if (bgTasks.size > 50) {
          // Keep the registry bounded: drop the oldest finished task.
          const oldest = [...bgTasks.values()].find((t) => t.done);
          if (oldest) bgTasks.delete(oldest.id);
        }
        return `${statusLine(task)}\nPoll with task_output {"task_id": "${id}"}.`;
      }

      return await new Promise<string>((resolve, reject) => {
        const child = spawnShell(cwd, cmd);
        let out = "";
        let timer: NodeJS.Timeout | undefined;
        const collect = (buf: Buffer) => {
          out += buf.toString();
          if (out.length > MAX_OUTPUT * 2) child.kill(); // runaway guard
        };
        child.stdout?.on("data", collect);
        child.stderr?.on("data", collect);
        timer = setTimeout(() => {
          child.kill();
          resolve(`[command timed out after ${TIMEOUT_MS / 1000}s — consider background=true]`);
        }, TIMEOUT_MS);
        child.on("error", (err) => {
          if (timer) clearTimeout(timer);
          reject(new Error(String(err.message)));
        });
        child.on("close", (code) => {
          if (timer) clearTimeout(timer);
          if (out.length > MAX_OUTPUT) out = out.slice(0, MAX_OUTPUT) + `\n…[output truncated at ${MAX_OUTPUT} chars]`;
          const status = code === 0 ? "" : `\n[exit code ${code}]`;
          resolve(out.trim() + status || "(no output)");
        });
      });
    },
  };

  const taskOutput: Tool = {
    name: "task_output",
    description:
      "Read a background task's output (and status). Optionally wait up to wait_ms for it to finish first. Poll repeatedly until a long task completes.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The id returned by shell with background=true." },
        wait_ms: { type: "number", description: "Wait up to this long for completion (default 1000, max 30000)." },
      },
      required: ["task_id"],
    },
    risk: "read",
    cacheable: false,
    async execute(args) {
      const t = bgTasks.get(String(args.task_id ?? ""));
      if (!t) return `error: no such task "${args.task_id}" (finished tasks are forgotten once replaced)`;
      const wait = Math.min(Math.max(Number(args.wait_ms) || 1000, 0), 30_000);
      const deadline = Date.now() + wait;
      while (!t.done && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      let out = t.out.length > MAX_OUTPUT ? t.out.slice(-MAX_OUTPUT) : t.out;
      if (out.length > MAX_OUTPUT) out = out.slice(0, MAX_OUTPUT) + "\n…[truncated]";
      return `${statusLine(t)}\n\n${out.trim() || "(no output yet)"}`;
    },
  };

  const taskKill: Tool = {
    name: "task_kill",
    description: "Kill a background task started with shell background=true, and return its output so far.",
    parameters: {
      type: "object",
      properties: { task_id: { type: "string", description: "The task id to terminate." } },
      required: ["task_id"],
    },
    risk: "risky",
    cacheable: false,
    async execute(args) {
      const t = bgTasks.get(String(args.task_id ?? ""));
      if (!t) return `error: no such task "${args.task_id}"`;
      if (!t.done) {
        t.child.kill();
        t.done = true;
        t.code = t.code ?? -2;
      }
      return `${statusLine(t)}\n\n${t.out.trim() || "(no output)"}`;
    },
  };

  return [shell, taskOutput, taskKill];
}

export { path };
