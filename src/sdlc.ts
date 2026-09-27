// sdlc.ts — the full software-development-lifecycle flow, run as phases:
//   plan → code → build → test → docs
// Each phase is one agent turn with a phase-specific directive, sharing one
// session so context carries forward. After each phase we diff the workspace
// and report what changed. `claw doc` is a focused single-phase variant that
// researches a topic and writes a markdown document.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatMsg } from "./types.ts";
import { Agent } from "./agent.ts";
import type { ClawConfig } from "./config.ts";
import type { SessionStore } from "./sessions.ts";
import { makeBanner, statusLine } from "./render.ts";
import { cyan, dim, green, red, yellow } from "./util.ts";

export const SDLC_PHASES = ["plan", "code", "build", "test", "docs"] as const;
export type SdlcPhase = (typeof SDLC_PHASES)[number];

const PHASE_INSTRUCTIONS: Record<SdlcPhase, string> = {
  plan: [
    `[PHASE: PLAN] You are planning a feature. First inspect the workspace (list_dir / glob / read_file).`,
    `Then write a plan to docs/PLAN.md using write_file. The plan must include:`,
    `  - Goal and scope`,
    `  - Architecture / file layout (concrete paths)`,
    `  - Step-by-step implementation tasks`,
    `  - How to build and test it (exact commands)`,
    `  - Acceptance criteria`,
    `Keep it concise but concrete. Do NOT write implementation code yet.`,
  ].join("\n"),
  code: [
    `[PHASE: CODE] Implement the plan in docs/PLAN.md. Write every file the plan calls for,`,
    `using write_file (one call per file) and edit_file for surgical changes.`,
    `Inspect existing files first so you don't clobber them. Finish with a glob to confirm all files exist.`,
  ].join("\n"),
  build: [
    `[PHASE: BUILD] Run the project's build or typecheck via the shell tool (e.g. "npm run build",`,
    `"npx tsc --noEmit", "go build ./...", "cargo build"). If it fails, read the errors, fix the files,`,
    `and re-run until it passes. If you cannot run it (no approval / missing toolchain), say so clearly`,
    `and report what you verified statically instead.`,
  ].join("\n"),
  test: [
    `[PHASE: TEST] Run the test suite via the shell tool (e.g. "npm test", "go test ./...").`,
    `Fix any failures you introduced and re-run. Report pass/fail per suite. If you cannot run tests,`,
    `say so and describe exactly which tests should exist and what they'd assert.`,
  ].join("\n"),
  docs: [
    `[PHASE: DOCS] Write documentation for what was built:`,
    `  - README.md at the project root (what it is, how to run, how to test)`,
    `  - docs/ with any API or design notes that matter`,
    `  - Append an entry to CHANGELOG.md (or create it) describing the change`,
    `Base the docs on the actual files — read them, don't guess.`,
  ].join("\n"),
};

export function runSdlc(
  agent: Agent,
  store: SessionStore,
  config: ClawConfig,
  sessionId: string,
  description: string,
  phases: SdlcPhase[],
): Promise<void> {
  const history: ChatMsg[] = [
    { role: "system", content: Agent.systemPrompt(config.workspace) },
    {
      role: "user",
      content: `[SDLC REQUEST] ${description}\nWork through the assigned phases in order. Keep a running account of what you build and why in the files you create.`,
    },
  ];
  return runPhases(agent, store, config, sessionId, history, phases, description);
}

/** `claw doc` — research + write a markdown document. */
export function runDoc(
  agent: Agent,
  store: SessionStore,
  config: ClawConfig,
  sessionId: string,
  topic: string,
  outPath: string,
): Promise<void> {
  const history: ChatMsg[] = [
    { role: "system", content: Agent.systemPrompt(config.workspace) },
    {
      role: "user",
      content: [
        `[DOC REQUEST] Research "${topic}" using web_search and web_fetch, then write a thorough markdown document.`,
        `Target file: ${outPath} (use write_file — create parent directories).`,
        `Structure: a title, a one-paragraph overview, detailed sections covering the topic, and a References`,
        `section listing the sources you actually used (with URLs).`,
        `Do not invent citations — only include sources you fetched. When done, confirm the file path and`,
        `give a 2-sentence summary of what's inside.`,
      ].join("\n"),
    },
  ];
  return runPhases(agent, store, config, sessionId, history, ["docs"], `doc: ${topic}`);
}

async function runPhases(
  agent: Agent,
  store: SessionStore,
  config: ClawConfig,
  sessionId: string,
  history: ChatMsg[],
  phases: SdlcPhase[],
  label: string,
): Promise<void> {
  for (const m of history) store.append(sessionId, m);

  console.log(makeBanner());
  statusLine([
    `model ${agent.provider.name} / ${agent.provider.model}`,
    `workspace ${config.workspace}`,
    cyan(`phases: ${phases.join(" → ")}`),
  ]);
  console.log(dim(`  task: ${label}`));

  const before = snapshotWorkspace(config.workspace);
  const key = `sdlc:${sessionId}`;

  for (const phase of phases) {
    console.log(green(`\n  ── PHASE ${phase.toUpperCase()} ──`));
    history.push({ role: "user", content: PHASE_INSTRUCTIONS[phase] });
    store.append(sessionId, { role: "user", content: PHASE_INSTRUCTIONS[phase] });

    const prevLen = history.length;
    const outcome = await agent.runTurn(key, history);
    history = outcome.history;
    for (const m of history.slice(prevLen)) store.append(sessionId, m);
    store.bumpTurns(sessionId, history.filter((m) => m.role === "user").length);

    if (outcome.aborted) {
      console.log(yellow(`  ⚠ phase ${phase} ended without a clean finish: ${outcome.answer}`));
    }
    const changed = diffWorkspace(before, snapshotWorkspace(config.workspace));
    reportChanges(changed);
    if (config.showCost) statusLine([dim(agent.ledger.report(agent.provider.model))]);
  }

  const total = diffWorkspace(before, snapshotWorkspace(config.workspace));
  console.log(green(`\n  ✔ SDLC complete: ${phases.join(" → ")}`));
  reportChanges(total);
  console.log(dim(`  session ${sessionId} — resume anytime with: claw continue`));
}

// ── workspace snapshots ─────────────────────────────────────────────

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".venv", "target", ".claw"]);

function snapshotWorkspace(root: string): Map<string, { mtime: number; size: number }> {
  const out = new Map<string, { mtime: number; size: number }>();
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(abs);
      } else {
        const rel = path.relative(root, abs);
        try {
          const st = fs.statSync(abs);
          out.set(rel, { mtime: st.mtimeMs, size: st.size });
        } catch {
          /* race */
        }
      }
    }
  };
  walk(root);
  return out;
}

function diffWorkspace(
  before: Map<string, { mtime: number; size: number }>,
  after: Map<string, { mtime: number; size: number }>,
): { created: string[]; changed: string[]; removed: string[] } {
  const created: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [rel, info] of after) {
    const prev = before.get(rel);
    if (!prev) created.push(rel);
    else if (prev.mtime !== info.mtime || prev.size !== info.size) changed.push(rel);
  }
  for (const rel of before.keys()) {
    if (!after.has(rel)) removed.push(rel);
  }
  return { created: created.sort(), changed: changed.sort(), removed: removed.sort() };
}

function reportChanges(d: { created: string[]; changed: string[]; removed: string[] }): void {
  for (const f of d.created) console.log(`  ${green("+")} ${f}`);
  for (const f of d.changed) console.log(`  ${yellow("~")} ${f}`);
  for (const f of d.removed) console.log(`  ${red("-")} ${f}`);
  if (!d.created.length && !d.changed.length && !d.removed.length) {
    console.log(dim("  (no files changed)"));
  }
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "doc";
}
