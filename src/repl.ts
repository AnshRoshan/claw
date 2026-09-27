// repl.ts — the interactive shell. Line-based input with arrow-key history
// and Tab-completion for slash commands, streaming output, and per-turn
// persistence so `claw --continue` can resume.
//
// Power-input modes (like Claude Code):
//   !cmd   run a shell command directly; its output joins the conversation
//   #note  append a memory note to the workspace CLAW.md (project instructions)
// Plus session tools: /usage /export /init /allow /unallow /compact …

import * as readline from "node:readline/promises";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatMsg, Provider } from "./types.ts";
import { Agent } from "./agent.ts";
import type { ClawConfig, ClawPaths } from "./config.ts";
import { appendHistoryFile, loadHistoryFile, SessionStore } from "./sessions.ts";
import { findCommand, listCommands, renderCommand } from "./commands.ts";
import { RouterProvider } from "./providers/router.ts";
import { banner, printAssistant, Screen, startThinking, statusLine, stopThinking, styleTrace, turnSummary } from "./render.ts";
import { bold, cyan, dim, green, red, yellow } from "./util.ts";

export interface ReplDeps {
  config: ClawConfig;
  agent: Agent;
  paths: ClawPaths;
  sessionId: string;
  approveState: { autoApprove: boolean; dryRun?: boolean; mode?: "default" | "plan" | "acceptEdits" };
  makeProvider: (model: string) => Provider;
  onExit: () => void;
}

const HELP_LINES = [
  yellow(bold("  CLAW slash commands")),
  "",
  "  /help                      show this help (Tab completes commands)",
  "  /model [name]              show or switch the model (or a model alias)",
  "  /backends                  live multi-backend routing status",
  "  /clear                     fresh session (new file, zero history)",
  "  /compact                   drop old turns to shrink the context window",
  "  /cost                      token usage + estimated spend",
  "  /usage                     context-window estimate + session usage",
  "  /export [file]             write the conversation to a markdown file",
  "  /init                      analyze the repo and create CLAW.md instructions",
  "  /mode [name]               permission mode: default | plan | acceptEdits | bypass",
  "  /yolo                      toggle auto-approve (skip the human gate)",
  "  /allow [prefix|list]       let a shell-command prefix run without asking",
  "  /unallow <prefix>          remove a runtime allowlist entry",
  "  /sessions                  list saved sessions",
  "  /resume <id>               continue an earlier session",
  "  /quit, /exit               leave (Ctrl+C also works)",
  "",
  dim("  Type a request like 'explain this repo' or 'build me a CLI'. End a line with \\ to continue it."),
  dim("  Start a line with ! to run a shell command, or # to add a note to CLAW.md."),
];

/** Any custom commands get their own /help block. */
function customHelpBlock(workspace: string, homeDir: string): string {
  const cmds = listCommands(workspace, homeDir);
  if (!cmds.length) return "";
  return [
    "",
    yellow(bold("  Custom commands (.claw/commands/*.md — $ARGUMENTS is the rest of the line)")),
    "",
    ...cmds.map((c) => `  /${c.name.padEnd(24)} ${dim(`(${c.source})`)}`),
  ].join("\n");
}

// ── input modes + session helpers (pure where possible, for selfcheck) ──

export const BUILTIN_SLASH = [
  "help", "model", "backends", "clear", "compact", "cost", "usage", "export", "init",
  "mode", "yolo", "allow", "unallow", "sessions", "resume", "quit", "exit",
];

/** Tab completion for slash lines: returns readline's [completions, partial]. */
export function completeSlash(line: string, workspace: string, homeDir: string): [string[], string] {
  if (!line.startsWith("/")) return [[], line];
  const names = [...BUILTIN_SLASH, ...listCommands(workspace, homeDir).map((c) => "/" + c.name)];
  const body = line.slice(1);
  if (/\s/.test(body)) return [[], line]; // typing args, not the command name
  const hits = (body === "" ? names : names.filter((n) => n.startsWith(body))).map((n) => "/" + n);
  return [hits, line];
}

/** `# note` → append a dated bullet under ## Memory notes in the workspace CLAW.md. */
export function appendMemoryNote(workspace: string, note: string): { file: string; created: boolean } {
  const file = path.join(workspace, "CLAW.md");
  const had = fs.existsSync(file);
  let text = had ? fs.readFileSync(file, "utf8") : "# CLAW.md — project instructions\n";
  if (!/^## Memory notes$/m.test(text)) {
    text = text.trimEnd() + "\n\n## Memory notes\n";
  }
  text = text.trimEnd() + `\n- (${new Date().toISOString().slice(0, 10)}) ${note.trim()}\n`;
  fs.writeFileSync(file, text, "utf8");
  return { file, created: !had };
}

/** Rough context-window estimate for /usage (~4 chars per token). */
export function contextEstimate(history: ChatMsg[]): { messages: number; chars: number; approxTokens: number } {
  const chars = history.reduce((a, m) => a + (m.content?.length ?? 0), 0);
  return { messages: history.length, chars, approxTokens: Math.round(chars / 4) };
}

/** Render a session history as a markdown transcript for /export. */
export function exportMarkdown(history: ChatMsg[], meta: { id: string; model: string; workspace: string }): string {
  const out: string[] = [
    `# CLAW session ${meta.id}`,
    ``,
    `_model: ${meta.model} · workspace: ${meta.workspace} · exported: ${new Date().toISOString()}_`,
    ``,
  ];
  for (const m of history) {
    if (m.role === "system") {
      if (m.content.startsWith("[Summary")) out.push(`## Context summary`, ``, m.content, ``);
      continue; // the standing system prompt is not part of the transcript
    }
    if (m.role === "user") out.push(`## User`, ``, m.content, ``);
    if (m.role === "assistant") {
      for (const tc of m.tool_calls ?? []) {
        out.push(`### Tool call — \`${tc.function.name}\``, "", "```json", tc.function.arguments, "```", "");
      }
      if (m.content.trim()) out.push(`## Assistant`, ``, m.content, ``);
    }
    if (m.role === "tool") out.push(`### Tool result`, "", "```", m.content.slice(0, 4000), "```", "");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** Run a user-typed `!command` directly (no approval gate — the human typed it). */
export function runUserShell(cwd: string, cmd: string, timeoutMs = 30_000): Promise<{ out: string; code: number }> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const child = spawn(isWin ? "cmd.exe" : "/bin/sh", isWin ? ["/d", "/s", "/c", cmd] : ["-c", cmd], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ out: out + "\n[timed out]", code: -1 });
    }, timeoutMs);
    const collect = (d: Buffer) => {
      out += d.toString();
      if (out.length > 20_000) child.kill();
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ out: out + err.message, code: -1 });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ out: out.trim(), code: code ?? -1 });
    });
  });
}

const INIT_PROMPT =
  "Analyze this project: read the README and manifest files (package.json / pyproject / Makefile / Cargo.toml …), skim the source layout, and detect the code style. Then WRITE a CLAW.md file at the workspace root — project instructions you can follow in future sessions. Include: 1-2 line project overview, exact build/test/run commands, where the main code lives, code style conventions, and any gotchas. Keep it under 80 lines, terse and concrete. Finish by summarizing what you wrote in one sentence.";

export async function runRepl(deps: ReplDeps): Promise<void> {
  const { config, agent, paths } = deps;
  const store = new SessionStore(paths.homeDir + "/sessions");
  let sid = deps.sessionId;
  let history: ChatMsg[] = store.load(sid);
  if (history.length === 0) {
    history = [{ role: "system", content: Agent.systemPrompt(config.workspace) }];
  } else {
    // Resuming a session that was summarized on close? Re-inject the summary
    // right after the system prompt so the model re-orients instantly.
    const meta = store.meta(sid);
    if (meta?.summary && !history.some((m) => m.content.startsWith("[Summary of a previous session]"))) {
      history.splice(1, 0, {
        role: "system",
        content: `[Summary of a previous session]\n${meta.summary}`,
      });
      console.log(dim("  (restored the previous session's summary — see /cost for tokens)"));
    }
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    completer: (line: string) => completeSlash(line, config.workspace, paths.homeDir),
  } as Parameters<typeof readline.createInterface>[0]);
  rl.setPrompt(`${green(bold("claw"))} ${dim("(" + agent.provider.model + ")")} ${cyan("❯ ")}`);
  // readline's `history` property exists at runtime but is not in the public types.
  (rl as unknown as { history: string[] }).history = loadHistoryFile(paths.homeDir + "/history", 200);

  banner();
  statusLine([
    dim("model ") + `${agent.provider.name} / ${agent.provider.model}`,
    dim("workspace ") + config.workspace,
    dim("session " + sid),
    dim("type /help for commands"),
  ]);
  rl.prompt();

  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) {
      rl.prompt();
      continue;
    }
    if (line.startsWith("/")) {
      const quit = await runSlash(line, deps, store, sid, history, (h) => (history = h), (id) => (sid = id));
      if (quit) break;
      rl.prompt();
      continue;
    }
    // `!cmd` — run a shell command directly; its output joins the conversation.
    if (line.startsWith("!") && line.slice(1).trim()) {
      appendHistoryFile(paths.homeDir + "/history", line);
      const cmd = line.slice(1).trim();
      const { out, code } = await runUserShell(config.workspace, cmd);
      console.log(dim(`  $ ${cmd}`));
      console.log(out ? out : dim("  (no output)"));
      if (code !== 0) console.log(yellow(`  exit ${code}`));
      history.push({
        role: "user",
        content: `[user ran shell command]\n$ ${cmd}\n\nOutput (exit ${code}):\n${out}`,
      });
      store.append(sid, history[history.length - 1]);
      rl.prompt();
      continue;
    }
    // `#note` — persist a memory note into the workspace CLAW.md.
    if (line.startsWith("#") && line.slice(1).trim()) {
      appendHistoryFile(paths.homeDir + "/history", line);
      const { file, created } = appendMemoryNote(config.workspace, line.slice(1));
      console.log(green(`  noted in ${file}${created ? " (created)" : ""}`));
      rl.prompt();
      continue;
    }

    appendHistoryFile(paths.homeDir + "/history", line);
    await runTurn(deps, store, sid, history, line, (h) => (history = h));
    rl.prompt();
  }

  // ── Summarize-on-close: persist an LLM summary into the session header ──
  // `claw continue` and /resume re-inject it, so resuming re-orients the
  // model instantly instead of replaying the whole history cold.
  if (history.filter((m) => m.role !== "system").length >= 4) {
    console.log(dim("  summarizing session for next time…"));
    const summary = await Agent.summarizeSession(agent.provider, history);
    if (summary) {
      store.updateMeta(sid, { summary });
      console.log(green("  summary saved — `claw continue` will restore it"));
    }
  }

  deps.onExit();
}

async function runTurn(
  deps: ReplDeps,
  store: SessionStore,
  sid: string,
  history: ChatMsg[],
  text: string,
  setHistory: (h: ChatMsg[]) => void,
): Promise<void> {
  const { config, agent } = deps;
  const screen = new Screen({ trace: styleTrace });
  history.push({ role: "user", content: text });
  store.append(sid, { role: "user", content: text });

  // Streaming: deltas go into the chat panel. Non-streaming: spinner.
  let streamed = false;
  const stream = config.stream && agent.provider.streamable;
  const prevLog = agent.opts.log;
  const prevOnText = agent.opts.onText;
  agent.opts.log = (s) => screen.line(s);
  agent.opts.onText = (d) => {
    streamed = true;
    screen.stream(d);
  };
  const timer = stream ? undefined : startThinking();

  const prevLen = history.length;
  const outcome = await agent.runTurn(`terminal:${sid}`, history);
  stopThinking(timer);
  screen.end();
  agent.opts.log = prevLog;
  agent.opts.onText = prevOnText;
  if (!streamed) {
    printAssistant(outcome.answer);
  }

  // Persist the new messages (assistant steps + tool results).
  for (const m of history.slice(prevLen)) store.append(sid, m);
  setHistory(outcome.history);
  store.bumpTurns(sid, outcome.history.filter((m) => m.role === "user").length);

  if (config.showCost) {
    console.log(
      turnSummary([
        outcome.toolCallsMade ? `${outcome.toolCallsMade} tool call${outcome.toolCallsMade === 1 ? "" : "s"}` : null,
        agent.ledger.report(agent.provider.model),
      ]),
    );
  }
}

/** Returns true when the user asked to quit. */
async function runSlash(
  line: string,
  deps: ReplDeps,
  store: SessionStore,
  sid: string,
  history: ChatMsg[],
  setHistory: (h: ChatMsg[]) => void,
  setSid: (id: string) => void,
): Promise<boolean> {
  const { config, agent, paths } = deps;
  const [cmd, arg] = line.split(/\s+(.*)/, 2);

  switch (cmd) {
    case "/help":
      console.log(HELP_LINES.join("\n") + customHelpBlock(config.workspace, paths.homeDir));
      break;
    case "/model":
      if (arg) {
        try {
          agent.swapProvider(deps.makeProvider(arg.trim()));
          console.log(green(`  → model: ${agent.provider.name} / ${agent.provider.model}`));
        } catch (err) {
          console.log(red(`  ${(err as Error).message}`));
        }
      } else {
        console.log(`  current: ${agent.provider.name} / ${agent.provider.model}`);
      }
      break;
    case "/backends": {
      const p = agent.provider;
      if (p instanceof RouterProvider) {
        console.log(`  routing: ${p.strategyLabel()}`);
        for (const line of p.report()) console.log(line);
      } else {
        console.log(`  ${p.name} / ${p.model} (single backend)`);
      }
      break;
    }
    case "/clear": {
      const fresh = store.create(agent.provider.model, config.baseURL, config.workspace);
      setHistory([{ role: "system", content: Agent.systemPrompt(config.workspace) }]);
      setSid(fresh.id);
      console.log(green(`  fresh session ${fresh.id} — history cleared`));
      break;
    }
    case "/compact": {
      const h = Agent.compact(history, config.compactAt - 2);
      setHistory(h);
      console.log(green(`  compacted to ${h.length} messages`));
      break;
    }
    case "/cost":
      console.log(`  ${agent.ledger.report(agent.provider.model)}`);
      break;
    case "/mode": {
      if (arg) {
        const m = arg.trim();
        if (m === "plan" || m === "acceptEdits" || m === "default") {
          deps.approveState.mode = m;
          console.log(green(`  permission mode → ${m}${m === "plan" ? " (read-only — present a plan)" : m === "acceptEdits" ? " (edits auto-run, shell still asks)" : ""}`));
        } else if (m === "bypass") {
          deps.approveState.autoApprove = true;
          deps.approveState.mode = undefined;
          console.log(yellow("  ⚠ bypass: risky tools run without asking"));
        } else {
          console.log(yellow(`  unknown mode "${m}" — default | plan | acceptEdits | bypass`));
        }
      } else {
        console.log(`  permission mode: ${deps.approveState.mode ?? "default"}${deps.approveState.autoApprove ? " (bypass)" : ""}`);
      }
      break;
    }
    case "/yolo":
      config.autoApprove = !config.autoApprove;
      deps.approveState.autoApprove = config.autoApprove;
      console.log(
        config.autoApprove
          ? yellow("  ⚠ auto-approve ON — risky tools run without asking")
          : green("  auto-approve OFF"),
      );
      break;
    case "/sessions": {
      const list = store.list().slice(0, 10);
      if (!list.length) {
        console.log("  no saved sessions");
      } else {
        for (const s of list) {
          console.log(`  ${s.id}  ${s.model}  ${s.turns} turns  ${new Date(s.createdAt).toLocaleString()}`);
        }
      }
      break;
    }
    case "/resume": {
      if (!arg) {
        console.log(yellow("  usage: /resume <session-id>  (see /sessions)"));
        break;
      }
      const msgs = store.load(arg.trim());
      if (!msgs.length) {
        console.log(red(`  no session ${arg}`));
        break;
      }
      setHistory(msgs);
      setSid(arg.trim());
      console.log(green(`  resumed ${arg} (${msgs.length} messages)`));
      break;
    }
    case "/usage": {
      const est = contextEstimate(history);
      console.log(green("  context: ") + `${est.messages} messages · ~${est.approxTokens.toLocaleString()} tokens estimated` + dim(` (compacts past ${config.compactAt})`));
      console.log(green("  session: ") + agent.ledger.report(agent.provider.model));
      console.log(green("  model:   ") + `${agent.provider.name} / ${agent.provider.model}`);
      break;
    }
    case "/export": {
      const target = (arg && arg.trim()) || `claw-${sid}.md`;
      const file = path.isAbsolute(target) ? target : path.join(config.workspace, target);
      const md = exportMarkdown(history, { id: sid, model: agent.provider.model, workspace: config.workspace });
      try {
        fs.writeFileSync(file, md, "utf8");
        console.log(green(`  exported ${history.length} messages → ${file}`));
      } catch (err) {
        console.log(red(`  could not write ${file}: ${(err as Error).message}`));
      }
      break;
    }
    case "/init": {
      console.log(dim("  analyzing the repo to write CLAW.md…"));
      await runTurn(deps, store, sid, history, INIT_PROMPT, setHistory);
      break;
    }
    case "/allow": {
      const prefix = (arg && arg.trim()) || "";
      if (!prefix) {
        console.log(green("  allowlisted shell prefixes: ") + (config.shellAllowlist.length ? config.shellAllowlist.join(dim(" · ")) : dim("(none)")));
        console.log(dim("  usage: /allow <prefix>  (this session only; persist it in .claw.json)"));
        break;
      }
      if (!config.shellAllowlist.includes(prefix)) config.shellAllowlist.push(prefix);
      console.log(green(`  allowed commands starting with "${prefix}"`));
      break;
    }
    case "/unallow": {
      const prefix = (arg && arg.trim()) || "";
      const i = config.shellAllowlist.indexOf(prefix);
      if (i >= 0) {
        config.shellAllowlist.splice(i, 1);
        console.log(green(`  removed "${prefix}" from the allowlist`));
      } else {
        console.log(yellow(`  "${prefix}" is not on the allowlist`));
      }
      break;
    }
    case "/quit":
    case "/exit":
      return true;
    default: {
      // Custom command? `.claw/commands/<name>.md` → expand + run as a turn.
      const command = findCommand(cmd.slice(1), config.workspace, paths.homeDir);
      if (command) {
        console.log(dim(`  /${command.name} (${command.source} command)`));
        appendHistoryFile(paths.homeDir + "/history", line);
        await runTurn(deps, store, sid, history, renderCommand(command.template, arg ?? ""), setHistory);
        return false;
      }
      console.log(yellow(`  unknown command ${cmd} — try /help`));
    }
  }
  return false;
}
