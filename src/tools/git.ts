// tools/git.ts — the git tool pair from the architecture docs ("Where to
// grow it"): read-only status/diff/log tools plus git_commit behind the human
// approval gate. Unlike the shell tool, these spawn `git` directly with an
// argv array — no shell interpolation, so arguments can't be chained.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Tool } from "../types.ts";

const MAX_OUTPUT = 10_000;
const TIMEOUT_MS = 15_000;

/** Run `git <args>` in the workspace; returns stdout+stderr. */
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const collect = (buf: Buffer) => {
      out += buf.toString();
      if (out.length > MAX_OUTPUT * 2) child.kill(); // runaway guard
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`git ${args[0]} timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`git is not available: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (out.length > MAX_OUTPUT) out = out.slice(0, MAX_OUTPUT) + `\n…[output truncated at ${MAX_OUTPUT} chars]`;
      const text = out.trim() || "(no output)";
      if (code === 0) resolve(text);
      else resolve(`${text}\n[git exit code ${code}]`);
    });
  });
}

export function makeGitTools(root: string): Tool[] {  const cwd = path.resolve(root);

  const status: Tool = {
    name: "git_status",
    description:
      "Show the git working-tree state of the workspace: current branch and every staged/modified/untracked file (porcelain format).",
    parameters: { type: "object", properties: {} },
    risk: "read",
    cacheable: false, // the working tree changes under us
    async execute() {
      const branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
      const st = await git(cwd, ["status", "--porcelain", "-b"]);
      return `${branch}\n${st}`;
    },
  };

  const diff: Tool = {
    name: "git_diff",
    description:
      "Show a git diff of the workspace. Use staged=true for the staged diff, path to limit it to one file. Empty output means no changes.",
    parameters: {
      type: "object",
      properties: {
        staged: { type: "boolean", description: "Show the staged (--cached) diff instead of the working-tree diff." },
        path: { type: "string", description: "Limit the diff to this file or directory." },
      },
    },
    risk: "read",
    cacheable: false,
    async execute(args) {
      const a = ["diff"];
      if (args.staged === true) a.push("--cached");
      a.push("--");
      if (typeof args.path === "string" && args.path.trim()) a.push(args.path.trim());
      return await git(cwd, a);
    },
  };

  const log: Tool = {
    name: "git_log",
    description: "Show the most recent commits (hash, author, relative date, subject). Defaults to 10; max 50.",
    parameters: {
      type: "object",
      properties: { n: { type: "number", description: "How many commits to show (default 10, max 50)." } },
    },
    risk: "read",
    cacheable: false,
    async execute(args) {
      const n = Math.min(Math.max(Number(args.n) || 10, 1), 50);
      return await git(cwd, ["log", "--oneline", "--decorate", `-${n}`]);
    },
  };

  const commit: Tool = {
    name: "git_commit",
    description:
      "Stage and commit the workspace's changes with a commit message. Stages everything (git add -A) unless add_all=false, in which case only what is already staged is committed. Requires approval.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "The commit message (first line is the subject)." },
        add_all: { type: "boolean", description: "Stage all changes first (default true)." },
      },
      required: ["message"],
    },
    risk: "risky", // mutates history-bearing state → human approval gate
    cacheable: false,
    async execute(args) {
      const message = String(args.message ?? "").trim();
      if (!message) throw new Error("git_commit needs a non-empty message");
      if (args.add_all !== false) await git(cwd, ["add", "-A"]);
      const out = await git(cwd, ["commit", "-m", message]);
      const hash = await git(cwd, ["rev-parse", "--short", "HEAD"]);
      return `${out}\n${hash}`;
    },
  };

  return [status, diff, log, commit];
}

// ── worktree isolation for parallel sub-agents ────────────────────────
// `git worktree add` materializes a second working directory on its own
// branch, sharing the same repository — the cheap, correct way to let N
// sub-agents edit files in parallel without colliding. Branches are LEFT
// behind on purpose: merging is a human decision.

export function isGitRepo(root: string): boolean {
  try {
    return fs.statSync(path.join(root, ".git"), { throwIfNoEntry: false }) !== undefined;
  } catch {
    return false;
  }
}

export interface Worktree {
  name: string;
  path: string;
  branch: string;
}

/**
 * Create a worktree `<root>/.claw/worktrees/<name>` on branch
 * `claw/<name>`. Returns null when the workspace isn't a git repo or the
 * name is already taken.
 */
export async function createWorktree(root: string, name: string): Promise<Worktree | null> {
  const safe = name.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40);
  if (!safe) return null;
  const wtPath = path.join(root, ".claw", "worktrees", safe);
  const branch = `claw/${safe}`;
  try {
    const out = await git(root, ["worktree", "add", "-b", branch, wtPath]);
    // git() resolves (not rejects) on nonzero exit — verify the worktree
    // actually materialized instead of trusting the exit code.
    if (out.includes("[git exit code") || !fs.existsSync(path.join(wtPath, ".git"))) return null;
  } catch {
    return null; // git missing or crashed
  }
  return { name: safe, path: wtPath, branch };
}

/** Remove a worktree (its branch keeps the work). */
export async function removeWorktree(root: string, name: string): Promise<void> {
  const safe = name.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40);
  const wtPath = path.join(root, ".claw", "worktrees", safe);
  try {
    await git(root, ["worktree", "remove", "--force", wtPath]);
  } catch {
    /* already gone */
  }
}
