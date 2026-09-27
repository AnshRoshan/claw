// config.ts — layered configuration, lowest priority first:
//
//   1. built-in defaults
//   2. environment variables (CLAW_*)
//   3. user config  ~/.claw/config.json
//   4. project config  ./.claw.json
//   5. CLI flags (applied by cli.ts)
//
// Values are merged shallowly per top-level key, so a project config can
// override just { "model": "..." } and keep the user's base URL.

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import type { McpServerCfg } from "./mcp.ts";
import type { RouteStrategy } from "./providers/router.ts";
import { ensureDir, isTruthy, readFileOr } from "./util.ts";
import type { BackendBudget } from "./providers/router.ts";

export interface ClawConfig {
  /** OpenAI-compatible endpoint (OmniRoute / Ollama / LM Studio / OpenAI). */
  baseURL: string;
  model: string;
  /** Env var name holding the API key, or the key itself. */
  apiKey: string;
  maxIterations: number;
  /** The ONE folder the agent may touch. Defaults to cwd. */
  workspace: string;
  /** Tool names that trip the human approval gate. */
  riskyTools: string[];
  /** Shell commands allowed without approval (prefix match). */
  shellAllowlist: string[];
  /** Skip all approval prompts (Claude Code calls this --dangerously-skip-permissions). */
  autoApprove: boolean;
  /** Permission mode: default | plan | acceptEdits | bypass (Claude Code / Codex). */
  permissionMode: "default" | "plan" | "acceptEdits" | "bypass";
  /** User hooks (Claude Code-style): shell commands observing tool calls.
   *  Payload arrives as JSON on stdin; beforeTool exit code 2 vetoes the call. */
  hooks: { beforeTool?: string; afterTool?: string; onTurnEnd?: string };
  /** Stream text deltas when the provider supports it. */
  stream: boolean;
  /** Show the live Think→Act→Observe trace. */
  verbose: boolean;
  /** Compress conversation when it exceeds this many messages. */
  compactAt: number;
  /** Cap on a single tool result fed back to the model. */
  outputCap: number;
  /** Print cost reports after every turn. */
  showCost: boolean;
  /** MCP servers: name → { command/args (stdio) or url (http) }. */
  mcpServers: Record<string, McpServerCfg>;
  /** Native web_search backend: auto | duckduckgo | tavily | brave | tinyfish. */
  searchProvider: string;
  /** Model aliases: name → one or more backends (multi-model routing). */
  models: Record<string, ModelAliasSpec>;
  /** Wire protocol: openai (default) or anthropic. Set by /setup. */
  providerType: "openai" | "anthropic";
  /** Sub-agent (delegation) options. */
  subagents: {
    enabled: boolean;
    maxDepth: number;
    timeoutMs: number;
    maxConcurrency: number;
    /** Parallel tasks each get their own git worktree (branch claw/*). */
    worktree: boolean;
    /** Token ceiling per sub-agent. */
    budget?: { maxInputTokens?: number; maxOutputTokens?: number };
  };
}

/** One backend inside a model alias: endpoint + model + key(s). */
export interface ModelBackendSpec {
  type?: "openai" | "anthropic" | "mock";
  baseURL?: string;
  model?: string;
  /** Env var name or literal key. */
  apiKey?: string;
  /** Extra keys — auth failures rotate through them (key rotation). */
  keys?: string[];
  /** For the weighted strategy. */
  weight?: number;
  /** Spending ceiling — a backend that crosses it is skipped until the
   * others are spent too (cheap backends first). */
  budget?: BackendBudget;
}

export interface ModelAliasSpec {
  strategy?: RouteStrategy;
  backends: ModelBackendSpec[];
}

export const DEFAULTS: ClawConfig = {
  baseURL: "http://127.0.0.1:20128/v1", // the OmniRoute gateway from claw-orchestrator
  model: "free-stack",
  apiKey: "OMNIROUTE_API_KEY",
  maxIterations: 16,
  workspace: ".",
  riskyTools: ["shell", "git_commit", "delete_file"],
  shellAllowlist: ["echo", "date", "pwd", "ls", "whoami", "hostname"],
  autoApprove: false,
  permissionMode: "default" as const,
  hooks: {},
  stream: true,
  verbose: true,
  compactAt: 40,
  outputCap: 4000,
  showCost: true,
  mcpServers: {},
  searchProvider: "auto",
  models: {},
  providerType: "openai",
  subagents: { enabled: true, maxDepth: 3, timeoutMs: 120_000, maxConcurrency: 4, worktree: false },
};

export interface ClawPaths {
  homeDir: string; // ~/.claw — config, sessions, history
  userConfig: string;
  projectConfig: string;
}

export function clawPaths(): ClawPaths {
  // CLAW_HOME isolates all state (config, sessions, tokens) — used by tests
  // and by anyone running multiple independent claw installs.
  const homeDir = process.env.CLAW_HOME ?? path.join(homedir(), ".claw");
  return {
    homeDir,
    userConfig: path.join(homeDir, "config.json"),
    projectConfig: path.join(process.cwd(), ".claw.json"),
  };
}

function readJson<T>(p: string): T | null {
  const raw = readFileOr(p);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    console.warn(`⚠  ${p} is not valid JSON — ignoring it (${(err as Error).message})`);
    return null;
  }
}

/**
 * The key actually used to talk to the endpoint. `apiKey` is either the name
 * of an env var (the default, OMNIROUTE_API_KEY) or a literal key. Returns
 * undefined when the named env var is unset — which flips CLAW to the mock.
 */
export function resolveApiKey(config: Pick<ClawConfig, "apiKey">): string | undefined {
  const raw = config.apiKey;
  if (!raw) return undefined;
  if (raw in process.env) return process.env[raw];
  if (raw === DEFAULTS.apiKey) return undefined; // default name, env var unset
  return raw; // a literal key
}

export function loadConfig(overrides: Partial<ClawConfig> = {}): ClawConfig {
  const paths = clawPaths();
  const user = readJson<Partial<ClawConfig>>(paths.userConfig) ?? {};
  const project = readJson<Partial<ClawConfig>>(paths.projectConfig) ?? {};

  const env = {
    baseURL: process.env.CLAW_BASE_URL,
    model: process.env.CLAW_MODEL,
    apiKey: process.env.CLAW_API_KEY,
    workspace: process.env.CLAW_WORKSPACE,
  };

  const pick = <K extends keyof ClawConfig>(
    key: K,
    envVal: string | undefined,
  ): ClawConfig[K] => {
    if (overrides[key] !== undefined) return overrides[key] as ClawConfig[K];
    if (envVal !== undefined) {
      // Only treat non-empty env values as overrides.
      if (envVal !== "") return envVal as unknown as ClawConfig[K];
    }
    if (project[key] !== undefined) return project[key] as ClawConfig[K];
    if (user[key] !== undefined) return user[key] as ClawConfig[K];
    return DEFAULTS[key];
  };

  // MCP servers merge across layers (project overrides user; both kept).
  const userMcp = (user.mcpServers ?? {}) as Record<string, McpServerCfg>;
  const projectMcp = (project.mcpServers ?? {}) as Record<string, McpServerCfg>;

  // Model aliases merge the same way.
  const userModels = (user.models ?? {}) as Record<string, ModelAliasSpec>;
  const projectModels = (project.models ?? {}) as Record<string, ModelAliasSpec>;

  return {
    baseURL: pick("baseURL", env.baseURL),
    model: pick("model", env.model),
    apiKey: pick("apiKey", env.apiKey),
    maxIterations: pick("maxIterations", undefined),
    workspace: pick("workspace", env.workspace),
    riskyTools: pick("riskyTools", undefined),
    shellAllowlist: pick("shellAllowlist", undefined),
    autoApprove: pick("autoApprove", undefined) ??
      (env.apiKey !== undefined ? isTruthy(process.env.CLAW_AUTO_APPROVE) : false),
    permissionMode: pick("permissionMode", undefined) ?? DEFAULTS.permissionMode,
    hooks: {
      beforeTool: pick("hooks", undefined)?.beforeTool ?? undefined,
      afterTool: pick("hooks", undefined)?.afterTool ?? undefined,
      onTurnEnd: pick("hooks", undefined)?.onTurnEnd ?? undefined,
    },
    stream: pick("stream", undefined),
    verbose: pick("verbose", undefined),
    compactAt: pick("compactAt", undefined),
    outputCap: pick("outputCap", undefined),
    showCost: pick("showCost", undefined),
    mcpServers: { ...userMcp, ...projectMcp },
    searchProvider: pick("searchProvider", process.env.CLAW_SEARCH_PROVIDER),
    providerType: pick("providerType", undefined),
    models: { ...userModels, ...projectModels },
    subagents: {
      enabled: pick("subagents", undefined)?.enabled ?? DEFAULTS.subagents.enabled,
      maxDepth: pick("subagents", undefined)?.maxDepth ?? DEFAULTS.subagents.maxDepth,
      timeoutMs: pick("subagents", undefined)?.timeoutMs ?? DEFAULTS.subagents.timeoutMs,
      maxConcurrency: pick("subagents", undefined)?.maxConcurrency ?? DEFAULTS.subagents.maxConcurrency,
      worktree: pick("subagents", undefined)?.worktree ?? DEFAULTS.subagents.worktree,
      budget: pick("subagents", undefined)?.budget,
    },
  };
}

/** clw init — write a documented project config. */
export function writeConfigFile(p: string, opts: { example?: boolean } = {}): string {
  ensureDir(path.dirname(p));
  const example: Partial<ClawConfig> & { _comment: string } = {
    _comment:
      "CLAW project config (full example). Omit keys to fall back to ~/.claw/config.json, env vars (CLAW_*), or defaults. Also try: a CLAW.md for project instructions, .claw/commands/*.md for custom slash commands.",
    baseURL: DEFAULTS.baseURL,
    model: "oc/deepseek-v4-flash-free",
    apiKey: "OMNIROUTE_API_KEY",
    maxIterations: 16,
    workspace: ".",
    autoApprove: false,
    stream: true,
    riskyTools: ["shell", "git_commit", "delete_file"],
    shellAllowlist: ["echo", "date", "pwd", "ls", "npm test"],
    outputCap: 4000,
    searchProvider: "auto",
    models: {
      "free-stack": {
        strategy: "failover",
        backends: [
          { baseURL: DEFAULTS.baseURL, model: "oc/deepseek-v4-flash-free", apiKey: "OMNIROUTE_API_KEY" },
          {
            baseURL: "https://api.openai.com/v1",
            model: "gpt-4o-mini",
            apiKey: "OPENAI_API_KEY",
            budget: { maxCalls: 200, maxUsd: 2.0 },
          },
        ],
      },
    },
    subagents: { enabled: true, maxDepth: 3, timeoutMs: 120000, maxConcurrency: 4, worktree: false },
    mcpServers: {
      tinyfish: { url: "https://agent.tinyfish.ai/mcp", transport: "http", trusted: true },
    },
  };
  const sample: Partial<ClawConfig> & { _comment: string } = opts.example
    ? example
    : {
        _comment:
          "CLAW project config. Omit keys to fall back to ~/.claw/config.json, env vars (CLAW_*), or defaults.",
        baseURL: DEFAULTS.baseURL,
        model: DEFAULTS.model,
        apiKey: "OMNIROUTE_API_KEY",
        maxIterations: 16,
        autoApprove: false,
        stream: true,
        riskyTools: ["shell", "git_commit", "delete_file"],
        shellAllowlist: ["echo", "date", "pwd", "ls", "whoami", "hostname"],
        subagents: { enabled: true, maxDepth: 3, timeoutMs: 120000, maxConcurrency: 4, worktree: false },
      };
  fs.writeFileSync(p, JSON.stringify(sample, null, 2) + "\n");
  return p;
}

/**
 * Merge a patch into the user config (~/.claw/config.json, or $CLAW_HOME).
 * This is how the web workbench's setup screen persists an API key —
 * the same layered config every channel already reads.
 */
export function updateUserConfig(patch: Record<string, unknown>): string {
  const p = clawPaths().userConfig;
  const existing = readJson<Record<string, unknown>>(p) ?? {};
  const json = JSON.stringify({ ...existing, ...patch }, null, 2);
  fs.writeFileSync(p, json + "\n");
  try {
    fs.chmodSync(p, 0o600); // keys live here — owner-only
  } catch {
    /* filesystems without chmod (Windows) — the file is still user-profile-scoped */
  }
  return p;
}

/**
 * Merge a patch into the project config (./.claw.json). The setup flow uses
 * this as a fallback because a project config outranks the user config.
 */
export function updateProjectConfig(patch: Record<string, unknown>): string {
  const p = clawPaths().projectConfig;
  const existing = readJson<Record<string, unknown>>(p) ?? {};
  const json = JSON.stringify({ ...existing, ...patch }, null, 2);
  fs.writeFileSync(p, json + "\n");
  return p;
}

/** `claw mcp add` — merge a server into the project config (or user config). */
export function addMcpServer(
  name: string,
  cfg: McpServerCfg,
  target: "project" | "user",
): string {
  const p = target === "project" ? clawPaths().projectConfig : clawPaths().userConfig;
  const existing = readJson<{ mcpServers?: Record<string, McpServerCfg> }>(p) ?? {};
  existing.mcpServers = { ...(existing.mcpServers ?? {}), [name]: cfg };
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(existing, null, 2) + "\n");
  return p;
}

/** `claw mcp remove` — delete a server from the project config (or user). */
export function removeMcpServer(name: string, target: "project" | "user"): string | null {
  const p = target === "project" ? clawPaths().projectConfig : clawPaths().userConfig;
  const existing = readJson<{ mcpServers?: Record<string, McpServerCfg> }>(p);
  if (!existing?.mcpServers?.[name]) return null;
  delete existing.mcpServers[name];
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(existing, null, 2) + "\n");
  return p;
}
