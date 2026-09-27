#!/usr/bin/env node
// cli.ts — CLAW's entry point. Wires config → provider → tools → guards →
// agent → channel. Subcommands: chat (default), run, continue, init, doctor,
// selfcheck, sessions.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { ChatMsg, Provider, Tool, ToolCall } from "./types.ts";
import { Agent } from "./agent.ts";
import { addMcpServer, clawPaths, loadConfig, removeMcpServer, resolveApiKey, writeConfigFile, type ClawConfig } from "./config.ts";
import { closeAllMcp, McpClient, mcpClients, mcpToolsToClawTools, type McpServerCfg } from "./mcp.ts";
import { mcpOAuthLogin, forgetToken } from "./oauth.ts";
import { defaultGuards } from "./guards.ts";
import { anyKeyConfigured, buildModelProvider, describeAlias, resolveKey } from "./providers/factory.ts";
import { RouterProvider } from "./providers/router.ts";
import { MockProvider } from "./providers/mock.ts";
import { makeDelegateTool, type DelegateCtx } from "./subagent.ts";
import { Ledger } from "./cost.ts";
import { makeFsTools } from "./tools/fs.ts";
import { makeEditTool } from "./tools/edit.ts";
import { makeCalcTool } from "./tools/calc.ts";
import { makeSearchTools } from "./tools/search.ts";
import { makeShellTools } from "./tools/shell.ts";
import { makeTodoTool } from "./tools/todo.ts";
import { makeGitTools } from "./tools/git.ts";
import { makeWebTool } from "./tools/web.ts";
import { makeWebSearchTool } from "./tools/web_search.ts";
import { providerSamplingHandler } from "./mcp.ts";
import { runDoc, runSdlc, SDLC_PHASES, slugify, type SdlcPhase } from "./sdlc.ts";
import { SessionStore } from "./sessions.ts";
import { runRepl } from "./repl.ts";
import { runSelfCheck } from "./selfcheck.ts";
import { startServe } from "./serve.ts";
import { askYesNo, makeBanner, printAssistant, Screen, statusLine, styleTrace, turnSummary } from "./render.ts";
import { dim, green, loadEnvFile, red, truncate, yellow } from "./util.ts";

const VERSION = "1.5.0";

const USAGE = `
${green("claw")} — a terminal coding agent (OpenCode × Claude Code, zero dependencies)

${dim("USAGE")}
  claw                      interactive chat (REPL)
  claw "fix the build"      one-shot: ask once, print the answer, exit
  claw run [file...]        task mode: whole file(s) become one message
  claw continue             resume the most recent session
  claw doc "topic"          research + write a markdown doc (docs/<slug>.md by default)
  claw sdlc "feature"       full SDLC flow: plan → code → build → test → docs
  claw serve                headless HTTP channel: POST /chat drives the same agent
  claw mcp <add|list|remove|test|login|logout>  manage MCP servers (Firecrawl, TinyFish, …)
  claw models               list model aliases + their backends (multi-model routing)
  claw init                 write a .claw.json project config
  claw doctor               check environment + API connectivity
  claw selfcheck            run the built-in assertion suite
  claw sessions             list saved sessions

${dim("OPTIONS")}
  -m, --model <name>        model to use (e.g. oc/deepseek-v4-flash-free)
  -b, --base <url>          OpenAI-compatible base URL
  -k, --api-key <key|env>   API key, or the env var holding it
      --anthropic           use the Anthropic API (needs ANTHROPIC_API_KEY)
  -M, --mock                force the scripted mock provider (offline demo)
  -w, --workspace <dir>     the ONE folder the agent may touch
  -y, --yolo                auto-approve risky tools (no human gate)
      --no-stream           disable streaming output
      --no-cost             hide the cost line after each turn
  -v, --verbose             show the Think→Act→Observe trace
      --phases <list>       (sdlc) run only these phases, e.g. plan,code,test
  -o, --out <path>          (doc) output path for the document
      --port <n>            (serve) port to listen on (default: random free port)
      --host <addr>         (serve) bind address (default 127.0.0.1; 0.0.0.0 to expose)
      --json                (one-shot/run) print the result as machine-readable JSON
      --dry-run              deny every risky tool, logging what WOULD have run
      --permission-mode <m>  default | plan (read-only, present a plan) | acceptEdits (edits auto, shell asks) | bypass
      --url <url>           (mcp add) register a remote http MCP endpoint
      --header <h>          (mcp add) extra HTTP header, e.g. "Authorization: Bearer \${T}"
      --oauth               (mcp add) this server uses OAuth (Authorization Code + PKCE)
      --auth-server <url>   (mcp add --oauth) explicit authorization server base URL
      --scopes <a,b>        (mcp add --oauth) scopes to request
      --trusted             (mcp add) skip the approval gate for that server
      --user                (mcp add/remove) edit ~/.claw/config.json instead of .claw.json
  -h, --help                this help
  -V, --version             version

${dim("REPL")}
  Slash commands with Tab-completion: /help /model /backends /clear /compact /cost
  /usage /export [file] /init /mode /yolo /allow /unallow /sessions /resume /quit
  !<cmd> runs a shell command directly (output joins the conversation);
  #<note> appends a memory note to the workspace CLAW.md.

${dim("CONFIG")}
  Priority: flags > .claw.json > ~/.claw/config.json > CLAW_* env > defaults.
  Provider: OpenAI-compatible (OmniRoute/Ollama/OpenAI/LM Studio) or Anthropic.
  No API key? Falls back to a scripted mock so you can always try it.
`.trim();

interface Flags {
  model?: string;
  base?: string;
  apiKey?: string;
  anthropic: boolean;
  mock: boolean;
  workspace?: string;
  yolo: boolean;
  stream: boolean;
  showCost: boolean;
  verbose: boolean;
  phases?: string;
  out?: string;
  port?: number;
  host?: string;
  url?: string;
  mcpHeaders?: string[];
  oauth: boolean;
  authServer?: string;
  scopes?: string;
  dryRun: boolean;
  permissionMode?: string;
  trusted: boolean;
  userCfg: boolean;
  json: boolean;
  help: boolean;
  version: boolean;
  command: string;
  positionals: string[];
}

function parseArgs(argv: string[]): Flags {
  const f: Flags = {
    anthropic: false,
    mock: false,
    yolo: false,
    stream: true,
    showCost: true,
    verbose: true,
    oauth: false,
    dryRun: false,
    trusted: false,
    userCfg: false,
    json: false,
    help: false,
    version: false,
    command: "chat",
    positionals: [],
  };
  const take = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("-")) {
      console.error(red(`missing value for ${flag}`));
      process.exit(2);
    }
    return v;
  };

  let i = 0;
  const seen: string[] = [];
  let stopFlags = false;
  for (; i < argv.length; i++) {
    const a = argv[i];
    // After the first positional (e.g. `claw mcp add firecrawl npx -y …`)
    // everything is a literal argument, not a flag.
    if (stopFlags) {
      f.positionals.push(a);
      continue;
    }
    switch (a) {
      case "-m": case "--model": f.model = take(i, a); i++; break;
      case "-b": case "--base": f.base = take(i, a); i++; break;
      case "-k": case "--api-key": f.apiKey = take(i, a); i++; break;
      case "-w": case "--workspace": f.workspace = take(i, a); i++; break;
      case "--anthropic": f.anthropic = true; break;
      case "-M": case "--mock": f.mock = true; break;
      case "-y": case "--yolo": f.yolo = true; break;
      case "--no-stream": f.stream = false; break;
      case "--no-cost": f.showCost = false; break;
      case "-v": case "--verbose": f.verbose = true; break;
      case "--phases": f.phases = take(i, a); i++; break;
      case "-o": case "--out": f.out = take(i, a); i++; break;
      case "--port": f.port = Number(take(i, a)); i++; break;
      case "--host": f.host = take(i, a); i++; break;
      case "--url": f.url = take(i, a); i++; break;
      case "--trusted": f.trusted = true; break;
      case "--user": f.userCfg = true; break;
      case "--json": f.json = true; break;
      case "--dry-run": f.dryRun = true; break;
      case "--permission-mode": f.permissionMode = take(i, a); i++; break;
      case "-h": case "--help": f.help = true; break;
      case "-V": case "--version": f.version = true; break;
      default:
        if (a.startsWith("-") && !seen.includes(a)) {
          console.error(red(`unknown flag: ${a}`));
          process.exit(2);
        }
        seen.push(a);
        f.positionals.push(a);
        // `serve` takes no positionals — keep parsing flags after it so
        // `claw serve --port 8799` works like any flag-first invocation.
        if (a !== "serve") stopFlags = true;
    }
  }

  const subs = new Set(["chat", "run", "continue", "init", "doctor", "selfcheck", "sessions", "mcp", "doc", "sdlc", "models", "serve"]);
  if (f.positionals.length && subs.has(f.positionals[0])) {
    f.command = f.positionals.shift()!;
  }
  // `claw mcp add tinyfish --url <url> --trusted`: those flags arrive inside
  // the positionals (everything after the subcommand is literal). Pull them
  // out so the http form reads naturally.
  if (f.command === "mcp") {
    f.mcpHeaders = [];
    const out: string[] = [];
    for (let i = 0; i < f.positionals.length; i++) {
      const t = f.positionals[i];
      if (t === "--url" && i + 1 < f.positionals.length) {
        f.url = f.positionals[i + 1];
        i++;
        continue;
      }
      if (t === "--header" && i + 1 < f.positionals.length) {
        f.mcpHeaders.push(f.positionals[i + 1]);
        i++;
        continue;
      }
      if (t === "--oauth") {
        f.oauth = true;
        continue;
      }
      if (t === "--auth-server" && i + 1 < f.positionals.length) {
        f.authServer = f.positionals[i + 1];
        i++;
        continue;
      }
      if (t === "--scopes" && i + 1 < f.positionals.length) {
        f.scopes = f.positionals[i + 1];
        i++;
        continue;
      }
      if (t === "--trusted") {
        f.trusted = true;
        continue;
      }
      if (t === "--user") {
        f.userCfg = true;
        continue;
      }
      out.push(t);
    }
    f.positionals = out;
  }
  return f;
}

async function main(): Promise<void> {
  loadEnvFile(path.join(process.cwd(), ".env"));
  const flags = parseArgs(process.argv.slice(2));

  if (flags.help) {
    console.log(USAGE);
    return;
  }
  if (flags.version) {
    console.log(`claw v${VERSION}`);
    return;
  }

  switch (flags.command) {
    case "init": {
      const example = flags.positionals.includes("--example");
      const p = clawPaths().projectConfig;
      if (fs.existsSync(p)) {
        console.log(yellow(`  ${p} already exists — leaving it alone`));
      } else {
        writeConfigFile(p, { example });
        console.log(green(`  wrote ${p}${example ? " (full example: models, budgets, sub-agents, MCP)" : ""}`));
      }
      return;
    }
    case "selfcheck":
      await runSelfCheck();
      return;
    case "doctor":
      await runDoctor();
      return;
    case "sessions": {
      const store = new SessionStore(clawPaths().homeDir + "/sessions");
      const list = store.list();
      if (!list.length) {
        console.log("  no saved sessions");
      } else {
        for (const s of list) {
          console.log(`  ${s.id}  ${s.model}  ${s.turns} turns  ${new Date(s.createdAt).toLocaleString()}`);
        }
      }
      return;
    }
    case "mcp":
      await runMcpCommand(flags);
      return;
    case "models":
      runModelsCommand();
      return;
    case "chat":
    case "run":
    case "continue":
    case "doc":
    case "sdlc":
    case "serve":
      break;
  }

  // ── Build the world ──
  const config: ClawConfig = loadConfig({
    model: flags.model,
    baseURL: flags.base,
    apiKey: flags.apiKey,
    workspace: flags.workspace,
    autoApprove: flags.yolo ? true : undefined,
    stream: flags.stream,
    showCost: flags.showCost,
    verbose: flags.verbose,
  });
  const workspace = path.resolve(config.workspace);
  if (!fs.existsSync(workspace)) {
    console.error(red(`workspace does not exist: ${workspace}`));
    process.exit(1);
  }
  config.workspace = workspace;
  // Own the array: guards capture this reference, and the REPL's /allow and
  // /unallow mutate it in place — without touching DEFAULTS or the config file.
  config.shellAllowlist = [...config.shellAllowlist];

  // Multi-model routing: an alias in `models` may fan out to many backends
  // (each with its own endpoint/model/key); a plain name is a single backend.
  const backendOpts = {
    baseURL: config.baseURL,
    defaultModel: config.model,
    defaultKey: config.apiKey,
    anthropic: flags.anthropic,
  };
  const hasExplicitModels = Object.keys(config.models).length > 0;

  let usingMock = false;
  const makeProvider = (model: string): Provider => {
    if (flags.mock) {
      usingMock = true;
      return new MockProvider(model);
    }
    // No keys anywhere and no explicit model aliases → offline scripted mock.
    if (!hasExplicitModels && !anyKeyConfigured(config) && !flags.anthropic) {
      usingMock = true;
      return new MockProvider(model);
    }
    if (flags.anthropic && !process.env.ANTHROPIC_API_KEY && !resolveKey(config.apiKey, config.apiKey)) {
      console.error(red("--anthropic needs ANTHROPIC_API_KEY (or --api-key)"));
      process.exit(1);
    }
    return buildModelProvider(model, config.models, backendOpts);
  };
  const provider = makeProvider(config.model);

  // Workspace-bound tools are rebuilt on workspace switch; MCP tools survive
  // (they belong to servers, not directories).
  const baseTools = (ws: string): Tool[] => [
    makeCalcTool(),
    ...makeFsTools(ws),
    makeEditTool(ws),
    ...makeSearchTools(ws),
    ...makeShellTools(ws),
    makeTodoTool(),
    ...makeGitTools(ws),
    makeWebTool(),
    makeWebSearchTool(config.searchProvider),
  ];

  // ── MCP servers: connect, list tools, merge into the toolset ──
  const mcpRisky: string[] = [];
  const mcpTools: Tool[] = [];
  for (const [name, cfg] of Object.entries(config.mcpServers)) {
    // Sampling: MCP servers may call the model back (sampling/createMessage);
    // answer them with CLAW's own provider.
    const client = new McpClient(name, cfg, { sampling: providerSamplingHandler(provider) });
    mcpClients.set(name, client);
    try {
      const infos = await client.connect();
      const mapped = mcpToolsToClawTools(name, infos, cfg);
      mcpTools.push(...mapped);
      for (const t of mapped) if (t.risk === "risky") mcpRisky.push(t.name);
      console.log(dim(`  mcp: ${name} → ${mapped.length} tool${mapped.length === 1 ? "" : "s"}`));
    } catch (err) {
      mcpClients.delete(name);
      console.log(yellow(`  ⚠ mcp server "${name}" failed: ${(err as Error).message}`));
      const stderr = client.lastStderr;
      if (stderr) console.log(dim(`    ${stderr}`));
    }
  }

  const rawMode: string | undefined = flags.permissionMode ?? (flags.dryRun ? "plan" : undefined);
  if (rawMode === "bypass") {
    flags.yolo = true; // bypassPermissions ≡ --yolo
  }
  const canAsk = process.stdin.isTTY;
  // Headless approval bridge: serve installs a broker here so the browser
  // becomes the human gate (the REPL keeps the TTY prompt below).
  let approvalBridge: ((call: ToolCall, sessionKey: string) => Promise<boolean>) | null = null;
  const ask = async (call: ToolCall, sessionKey = "top"): Promise<boolean> => {
    if (approvalBridge) return await approvalBridge(call, sessionKey);
    if (!canAsk) return false; // non-interactive: deny risky by default
    const args = truncate(call.function.arguments, 100);
    return await askYesNo(`approve ${call.function.name}(${args})?`);
  };

  /**
   * Build a complete world (tools + guards + agent) against one workspace.
   * Called once at startup and again on every workspace switch — everything
   * workspace-bound (confinement, fs tools, the system prompt) is rebuilt.
   */
  const buildWorld = (ws: string) => {
    const wsTools = [...baseTools(ws), ...mcpTools];
    // Dry-run means "nothing is modified": file-mutating tools join the
    // approval gate alongside the configured risky tools.
    const risky = flags.dryRun
      ? [...new Set([...config.riskyTools, "write_file", "edit_file", "mkdir", "move_file", "delete_file", ...mcpRisky])]
      : [...config.riskyTools, ...mcpRisky];
    const st = {
      autoApprove: config.autoApprove || flags.yolo,
      dryRun: flags.dryRun,
      mode: (rawMode === "plan" || rawMode === "acceptEdits" ? rawMode : undefined) as "plan" | "acceptEdits" | undefined,
    };
    const stGuards = defaultGuards(
      {
        workspace: ws,
        shellAllowlist: config.shellAllowlist,
        riskyTools: risky,
        outputCap: config.outputCap,
        hooks: config.hooks,
      },
      ask,
      st,
    );
    const ledger = new Ledger();
    let ag!: Agent;
    // Agent-to-agent handoff: the `delegate` tool spawns isolated sub-agents
    // (recursive up to maxDepth) whose usage merges into this ledger. Sub-agent
    // lifecycle events flow through the agent's CURRENT log sink.
    const toolset = (ctx: DelegateCtx): Tool[] => {
      if (!config.subagents.enabled) return wsTools;
      return [
        makeDelegateTool(
          {
            provider,
            makeToolset: toolset,
            guards: stGuards,
            maxDepth: config.subagents.maxDepth,
            timeoutMs: config.subagents.timeoutMs,
            maxIterations: config.maxIterations,
            compactAt: config.compactAt,
            verbose: false,
            workspace: ws,
            maxConcurrency: config.subagents.maxConcurrency,
            worktree: config.subagents.worktree,
            budget: config.subagents.budget,
            notify: (s) => ag.opts.log(s),
          },
          ctx,
        ),
        ...wsTools,
      ];
    };
    ag = new Agent(
      provider,
      toolset({ depth: 0, maxDepth: config.subagents.maxDepth, counter: 0, parentKey: "top", ledger }),
      {
        maxIterations: config.maxIterations,
        verbose: config.verbose,
        compactAt: config.compactAt,
        log: (s) => process.stdout.write(styleTrace(s) + "\n"),
        onText: () => {},
      },
      ledger,
    ).use(...stGuards);
    return {
      agent: ag,
      workspace: ws,
      setupRequired: usingMock && !flags.mock,
      approveState: st,
      settings: {
        allowlist: config.shellAllowlist,
        riskyTools: risky,
        hooks: {
          beforeTool: !!config.hooks.beforeTool,
          afterTool: !!config.hooks.afterTool,
          onTurnEnd: !!config.hooks.onTurnEnd,
        },
        baseURL: config.baseURL,
      },
      // Headless channels (serve) install an approval broker here; the shared
      // `ask` closure reads it, so every world built later sees it too.
      setApprovalBridge: (fn: ((call: ToolCall, sessionKey: string) => Promise<boolean>) | null) => {
        approvalBridge = fn;
      },
      // Runtime model swap (/model from the workbench): rebuild the provider
      // for an alias/name and hot-swap it into this world's agent.
      setModel: (name: string) => {
        ag.swapProvider(makeProvider(name));
        config.model = name;
        return { provider: ag.provider.name, model: ag.provider.model };
      },
      modelInfo: () => ({
        provider: ag.provider.name,
        model: ag.provider.model,
        aliases: Object.keys(config.models),
        defaultModel: config.model,
      }),
    };
  };

  const world = buildWorld(workspace);
  const agent = world.agent;
  const approveState = world.approveState!;

  const store = new SessionStore(clawPaths().homeDir + "/sessions");
  let sessionId = flags.command === "continue"
    ? store.latest()?.id ?? ""
    : "";

  const startSession = (): string => {
    const { id } = store.create(provider.model, config.baseURL, workspace);
    return id;
  };
  if (!sessionId) sessionId = startSession();

  if (usingMock && !flags.yolo) {
    console.log(yellow("  ⚠  no API key found — using the scripted mock provider. Set CLAW_API_KEY or run `claw init`."));
  }

  if (flags.command === "chat" && flags.positionals.length > 0) {
    // One-shot: the positional arguments are the prompt.
    await runOneShot(agent, store, sessionId, config, flags.positionals.join(" "), flags.json);
    await closeAllMcp();
    return;
  }

  if (flags.command === "run") {
    const texts: string[] = [];
    for (const p of flags.positionals) {
      const abs = path.resolve(p);
      if (!fs.existsSync(abs)) {
        console.error(red(`task file not found: ${p}`));
        process.exit(1);
      }
      texts.push(fs.readFileSync(abs, "utf8"));
    }
    // No task files? Read the whole task from stdin: `cat task.md | claw run`.
    if (texts.length === 0 && !process.stdin.isTTY) {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      texts.push(Buffer.concat(chunks).toString("utf8"));
    }
    if (texts.length === 0) {
      console.error(red("run needs a task file, or a piped task on stdin"));
      process.exit(1);
    }
    const task = texts.join("\n\n---\n\n");
    console.log(dim(`  task: ${flags.positionals.length ? flags.positionals.join(", ") : "(stdin)"} (${task.length} chars — sent as ONE message)`));
    await runOneShot(agent, store, sessionId, config, task, flags.json);
    await closeAllMcp();
    return;
  }

  if (flags.command === "doc") {
    const topic = flags.positionals.join(" ");
    if (!topic) {
      console.error(red('doc needs a topic: claw doc "research streaming LLMs"'));
      process.exit(1);
    }
    const out = flags.out ?? path.join("docs", slugify(topic) + ".md");
    await runDoc(agent, store, config, sessionId, topic, out);
    await closeAllMcp();
    return;
  }

  if (flags.command === "sdlc") {
    const desc = flags.positionals.join(" ");
    if (!desc) {
      console.error(red('sdlc needs a feature description: claw sdlc "build a todo API"'));
      process.exit(1);
    }
    let phases: SdlcPhase[] = [...SDLC_PHASES];
    if (flags.phases) {
      const wanted = flags.phases.split(",").map((s) => s.trim());
      phases = SDLC_PHASES.filter((p) => wanted.includes(p));
      if (!phases.length) {
        console.error(red(`unknown phases — valid: ${SDLC_PHASES.join(", ")}`));
        process.exit(1);
      }
    }
    await runSdlc(agent, store, config, sessionId, desc, phases);
    await closeAllMcp();
    return;
  }

  // Headless HTTP channel: many sessions, one agent, same guards.
  if (flags.command === "serve") {
    const homeDir = clawPaths().homeDir;
    const recordWorkspace = (dir: string): void => {
      const f = path.join(homeDir, "workspaces.json");
      let cur: { workspaces?: string[] } = {};
      try {
        cur = JSON.parse(fs.readFileSync(f, "utf8")) as { workspaces?: string[] };
      } catch {
        /* first entry */
      }
      cur.workspaces = [dir, ...(cur.workspaces ?? []).filter((x) => x !== dir)].slice(0, 8);
      fs.mkdirSync(homeDir, { recursive: true });
      fs.writeFileSync(f, JSON.stringify(cur, null, 2) + "\n");
    };
    await startServe({
      world,
      sessionsDir: homeDir + "/sessions",
      host: flags.host,
      port: flags.port,
      swapWorkspace: (dir) => {
        const w2 = buildWorld(dir);
        world.agent = w2.agent;
        world.workspace = w2.workspace;
        world.approveState = w2.approveState;
        world.settings = w2.settings;
        world.setupRequired = w2.setupRequired;
        world.setApprovalBridge = w2.setApprovalBridge;
        world.setModel = w2.setModel;
        world.modelInfo = w2.modelInfo;
        recordWorkspace(dir);
        return { ok: true };
      },
    });
    // Resolve when the process is killed; keep MCP children clean on exit.
    process.on("SIGINT", () => {
      void closeAllMcp().then(() => process.exit(0));
    });
    await new Promise<void>(() => {}); // serve until interrupted
  }

  // Interactive REPL (default / continue).
  const resumed = flags.command === "continue" && store.load(sessionId).length > 0;
  if (flags.command === "continue" && !resumed) {
    console.log(yellow("  no previous session to resume — starting fresh"));
  }
  await runRepl({
    config,
    agent,
    paths: clawPaths(),
    sessionId,
    approveState,
    makeProvider,
    onExit: () => void closeAllMcp(),
  });
}

/** `claw models` — show the default model and every configured alias/backend. */
function runModelsCommand(): void {
  const config = loadConfig({});
  const opts = {
    baseURL: config.baseURL,
    defaultModel: config.model,
    defaultKey: config.apiKey,
    anthropic: false,
  };
  console.log(green("  default model:"));
  try {
    const p = buildModelProvider(config.model, config.models, opts);
    console.log(`    ${p.name} / ${p.model}`);
    if (p instanceof RouterProvider) {
      for (const line of p.report()) console.log(line);
    }
  } catch (err) {
    console.log(red(`    ${(err as Error).message}`));
  }

  const aliases = Object.keys(config.models);
  if (aliases.length) {
    console.log(green("\n  model aliases:"));
    for (const name of aliases) {
      for (const line of describeAlias(name, config.models[name], opts)) console.log(line);
    }
  } else {
    console.log(dim("\n  no model aliases — add a \"models\" section to .claw.json for multi-model routing (see README)."));
  }
  console.log(dim("\n  In the REPL: /model <alias> switches; /backends shows live routing status."));
}

/** `claw mcp add|list|remove|test` — manage MCP servers in config. */
async function runMcpCommand(flags: Flags): Promise<void> {
  const [action, ...rest] = flags.positionals;
  const target: "project" | "user" = flags.userCfg ? "user" : "project";

  switch (action) {
    case "add": {
      const name = rest.shift();
      if (!name) {
        console.error(red("usage: claw mcp add <name> <command> [args...]   |   claw mcp add <name> --url <url> [--header \"Name: ${ENV_VAR}\"]"));
        process.exit(2);
      }
      let cfg: McpServerCfg;
      if (flags.url) {
        const headers: Record<string, string> = {};
        for (const h of flags.mcpHeaders ?? []) {
          const idx = h.indexOf(":");
          if (idx <= 0) {
            console.error(red(`--header expects "Name: value", got: ${h}`));
            process.exit(2);
          }
          headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
        }
        cfg = {
          url: flags.url,
          transport: "http",
          headers: Object.keys(headers).length ? headers : undefined,
          oauth: flags.oauth
            ? {
                authServer: flags.authServer,
                scopes: flags.scopes ? flags.scopes.split(",").map((x) => x.trim()) : undefined,
              }
            : undefined,
          trusted: flags.trusted || undefined,
        };
      } else {
        const command = rest.shift();
        if (!command) {
          console.error(red(`usage: claw mcp add ${name} <command> [args...]`));
          process.exit(2);
        }
        cfg = { command, args: rest, trusted: flags.trusted || undefined };
      }
      const p = addMcpServer(name, cfg, target);
      console.log(green(`  added mcp server "${name}" → ${p}`));
      return;
    }
    case "list": {
      const config = loadConfig({});
      const servers = Object.entries(config.mcpServers);
      if (!servers.length) {
        console.log("  no MCP servers configured — try: claw mcp add firecrawl npx -y firecrawl-mcp-server");
        return;
      }
      for (const [name, cfg] of servers) {
        const how = cfg.url
          ? `http ${cfg.url}`
          : `stdio ${cfg.command ?? "?"} ${(cfg.args ?? []).join(" ")}`.trim();
        console.log(`  ${name}  ${dim(how)}${cfg.trusted ? dim("  (trusted)") : ""}`);
      }
      return;
    }
    case "remove": {
      const name = rest.shift();
      if (!name) {
        console.error(red("usage: claw mcp remove <name>"));
        process.exit(2);
      }
      const p = removeMcpServer(name, target);
      if (!p) {
        console.log(yellow(`  no mcp server "${name}" in the ${target} config`));
      } else {
        console.log(green(`  removed mcp server "${name}" from ${p}`));
      }
      return;
    }
    case "test": {
      const name = rest.shift();
      if (!name) {
        console.error(red("usage: claw mcp test <name>"));
        process.exit(2);
      }
      const config = loadConfig({});
      const cfg = config.mcpServers[name];
      if (!cfg) {
        console.error(red(`no mcp server "${name}" configured`));
        process.exit(1);
      }
      const client = new McpClient(name, cfg);
      try {
        const tools = await client.connect();
        console.log(green(`  ✓ ${name}: connected, ${tools.length} tools:`));
        for (const t of tools) {
          console.log(`    ${t.name}${t.description ? dim(" — " + t.description.slice(0, 90)) : ""}`);
        }
      } catch (err) {
        console.error(red(`  ✗ ${name}: ${(err as Error).message}`));
        const stderr = client.lastStderr;
        if (stderr) console.error(dim("  stderr: " + stderr));
        process.exit(1);
      } finally {
        await client.close();
      }
      return;
    }
    case "login":
    case "logout": {
      const name = rest.shift();
      if (!name) {
        console.error(red(`usage: claw mcp ${action} <name>`));
        process.exit(2);
      }
      const config = loadConfig({});
      const serverCfg = config.mcpServers[name];
      if (!serverCfg?.url) {
        console.error(red(`no http mcp server "${name}" configured (claw mcp list)`));
        process.exit(1);
      }
      if (action === "logout") {
        forgetToken(name);
        console.log(green(`  forgot stored tokens for "${name}"`));
        return;
      }
      if (!serverCfg.oauth) {
        console.error(red(`server "${name}" has no oauth configured — add it with: claw mcp add ${name} --url <url> --oauth`));
        process.exit(1);
      }
      console.log(dim(`  opening your browser to authorize "${name}"…`));
      try {
        const tok = await mcpOAuthLogin(name, serverCfg.url, serverCfg.oauth === true ? {} : serverCfg.oauth);
        console.log(green(`  ✓ authorized "${name}" — token stored${tok.expires_at ? ` (expires ${new Date(tok.expires_at).toLocaleString()})` : ""}`));
      } catch (err) {
        console.error(red(`  ✗ ${(err as Error).message}`));
        process.exit(1);
      }
      return;
    }
    default:
      console.error(red(`unknown mcp action "${action ?? ""}" — use add, list, remove, test, login, logout`));
      process.exit(2);
  }
}

async function runOneShot(
  agent: Agent,
  store: SessionStore,
  sessionId: string,
  config: ClawConfig,
  prompt: string,
  jsonOut = false,
): Promise<void> {
  const history: ChatMsg[] = [{ role: "system", content: Agent.systemPrompt(config.workspace) }];
  history.push({ role: "user", content: prompt });
  store.append(sessionId, { role: "user", content: prompt });

  if (jsonOut) {
    // Machine-readable mode: no banner, no trace, no stream — just the JSON.
    agent.opts.log = () => {};
    agent.opts.onText = () => {};
    const outcome = await agent.runTurn(`oneshot:${sessionId}`, history);
    for (const m of outcome.history.slice(1)) store.append(sessionId, m);
    store.bumpTurns(sessionId, outcome.history.filter((m) => m.role === "user").length);
    const t = agent.ledger.totals;
    console.log(JSON.stringify({
      session_id: sessionId,
      answer: outcome.answer,
      tool_calls: outcome.toolCallsMade,
      aborted: outcome.aborted,
      model: agent.provider.model,
      workspace: config.workspace,
      usage: { input: t.input, output: t.output, cached: t.cacheRead, calls: t.calls },
    }, null, 2));
    return;
  }

  console.log(makeBanner());
  statusLine([`model ${agent.provider.name} / ${agent.provider.model}`, `workspace ${config.workspace}`]);

  const screen = new Screen({ trace: styleTrace });
  let streamed = false;
  const stream = config.stream && agent.provider.streamable;
  const prevLog = agent.opts.log;
  const prevOnText = agent.opts.onText;
  agent.opts.log = (s) => screen.line(s);
  if (stream) {
    agent.opts.onText = (d) => {
      streamed = true;
      screen.stream(d);
    };
  } else {
    agent.opts.onText = () => {};
  }
  const outcome = await agent.runTurn(`oneshot:${sessionId}`, history);
  screen.end();
  agent.opts.log = prevLog;
  agent.opts.onText = prevOnText;
  if (!streamed) {
    printAssistant(outcome.answer);
  }
  for (const m of outcome.history.slice(1)) store.append(sessionId, m);
  store.bumpTurns(sessionId, outcome.history.filter((m) => m.role === "user").length);

  if (config.showCost) {
    console.log(
      turnSummary([
        outcome.toolCallsMade ? `${outcome.toolCallsMade} tool call${outcome.toolCallsMade === 1 ? "" : "s"}` : null,
        agent.ledger.report(agent.provider.model),
      ]),
    );
  }
}

async function runDoctor(): Promise<void> {
  console.log(bannerText());
  const config = loadConfig({});
  const checks: Array<[string, boolean, string]> = [];

  checks.push(["node >= 23.6 (native TS)", process.versions.node.split(".")[0] >= "23", process.version]);
  checks.push(["workspace exists", fs.existsSync(path.resolve(config.workspace)), config.workspace]);

  const gitVersion = spawnSync("git", ["--version"], { encoding: "utf8" });
  checks.push([
    "git available",
    gitVersion.status === 0,
    gitVersion.status === 0 ? gitVersion.stdout.trim().replace("git version ", "v") : "not found — git tools disabled",
  ]);

  const key = resolveApiKey(config);
  checks.push(["API key found", !!key, key ? `from ${config.apiKey}` : "none — will use mock"]);

  const mcpCount = Object.keys(config.mcpServers).length;
  checks.push(["MCP servers", true, mcpCount ? `${mcpCount} configured (claw mcp list)` : "none (claw mcp add …)"]);

  const searchBackend = process.env.TINYFISH_API_KEY
    ? "tinyfish"
    : process.env.TAVILY_API_KEY
      ? "tavily"
      : process.env.BRAVE_API_KEY
        ? "brave"
        : "duckduckgo (keyless)";
  checks.push(["web search backend", true, searchBackend]);

  const aliasCount = Object.keys(config.models).length;
  checks.push(["model routing", true, aliasCount ? `${aliasCount} alias(es), ${describeAliasSummary(config)}` : `single model (${config.model})`]);

  if (key && !config.baseURL.includes("anthropic")) {
    // Connectivity probe: a tiny chat completion against the OpenAI-compatible endpoint.
    try {
      const resp = await fetch(config.baseURL.replace(/\/+$/, "") + "/models", {
        headers: key ? { authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(5000),
      });
      const models = (await resp.json().catch(() => null)) as { data?: Array<{ id: string }> } | null;
      checks.push(["endpoint reachable", resp.ok, `${config.baseURL} (HTTP ${resp.status})`]);
      const list = (models?.data ?? []).slice(0, 5).map((m) => m.id).join(", ");
      checks.push(["models visible", !!list, list || "no /models list"]);
    } catch (err) {
      checks.push(["endpoint reachable", false, (err as Error).message]);
    }
  }

  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? green("✓") : red("✗")} ${name}${detail ? dim(" — " + detail) : ""}`);
  }
  const allOk = checks.every(([, ok]) => ok);
  console.log(allOk ? green("\n  All checks passed.") : yellow("\n  Some checks need attention (the tool still runs with the mock)."));
}

function describeAliasSummary(config: ClawConfig): string {
  const parts: string[] = [];
  for (const [name, alias] of Object.entries(config.models)) {
    const n = alias.backends.reduce((acc, b) => acc + (b.keys?.length ?? 1), 0);
    parts.push(`${name}(${n})`);
  }
  return parts.join(", ");
}

function bannerText(): string {
  return makeBanner();
}

main().catch((err) => {
  console.error(red(`claw: ${(err as Error).message}`));
  process.exit(1);
});
