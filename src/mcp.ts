// mcp.ts — a Model Context Protocol client, implementing the two transports
// that matter in practice:
//
//   stdio — spawn an MCP server process, speak newline-delimited JSON-RPC
//           (Firecrawl via `npx -y firecrawl-mcp-server`, most local servers)
//   http  — the streamable HTTP transport: POST JSON-RPC to a URL, read
//           responses from the SSE stream (TinyFish at https://agent.tinyfish.ai/mcp)
//
// MCP tools are surfaced to the agent as ordinary CLAW tools, gated by the
// same guard stack. Unknown tools default to RISKY (human approval) unless
// the server is marked `trusted` or the tool name smells read-only.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ChatMsg, Provider, Tool } from "./types.ts";
import { sseEvents } from "./util.ts";
import { ensureToken, mcpOAuthLogin, type OAuthSpec } from "./oauth.ts";

export interface McpServerCfg {
  /** stdio: the command to spawn, e.g. "npx". */
  command?: string;
  /** stdio: args, e.g. ["-y", "firecrawl-mcp-server"]. */
  args?: string[];
  /** Extra environment variables. */
  env?: Record<string, string>;
  /** http: full MCP endpoint URL, e.g. https://agent.tinyfish.ai/mcp. */
  url?: string;
  transport?: "stdio" | "http";
  /** Extra HTTP headers for the http transport. Values may reference env
   * vars as ${VAR} (e.g. "Authorization: Bearer ${MY_TOKEN}") — secrets
   * stay in the environment, never in the config file. */
  headers?: Record<string, string>;
  /** OAuth: run the Authorization Code + PKCE flow for this http server.
   * `true` = discover everything; an object tunes authServer/scopes/
   * clientId. Tokens persist in ~/.claw/mcp-tokens.json; a 401 triggers
   * the browser flow automatically (once). */
  oauth?: boolean | OAuthSpec;
  /** Trusted servers skip the approval gate for ALL their tools. */
  trusted?: boolean;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** A message inside a sampling/createMessage request (MCP spec shape). */
export interface SamplingMessage {
  role: "user" | "assistant";
  content: { type?: string; text?: string } | string;
}

/** The params of a server-initiated sampling/createMessage request. */
export interface SamplingRequest {
  messages: SamplingMessage[];
  systemPrompt?: string;
  maxTokens?: number;
}

/** Server-initiated requests CLAW can answer. Today: sampling — MCP servers
 * can call the model back (e.g. a scraper that asks the model to summarize). */
export interface McpHandlers {
  sampling?: (req: SamplingRequest) => Promise<string>;
}

interface JsonRpc {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

const PROTOCOL_VERSION = "2025-03-26";

let nextId = 1;

export class McpClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, (r: JsonRpc) => void>();
  private stderrBuf = "";
  private closed = false;
  readonly tools: McpToolInfo[] = [];
  readonly name: string;
  readonly cfg: McpServerCfg;
  private handlers: McpHandlers;
  /** Bearer token from the OAuth flow (undefined when not configured). */
  private authToken: string | null = null;
  /** The 401 → browser-login retry happens at most once per client. */
  private authTried = false;

  constructor(name: string, cfg: McpServerCfg, handlers: McpHandlers = {}) {
    this.name = name;
    this.cfg = cfg;
    this.handlers = handlers;
  }

  private oauthSpec(): OAuthSpec {
    return this.cfg.oauth === true || this.cfg.oauth ? (this.cfg.oauth === true ? {} : this.cfg.oauth) : {};
  }

  /** Connect, negotiate, and list the server's tools. */
  async connect(): Promise<McpToolInfo[]> {
    const transport = this.cfg.transport ?? (this.cfg.url ? "http" : "stdio");
    if (transport === "http") {
      if (!this.cfg.url) throw new Error(`mcp server "${this.name}" needs a url for http transport`);
      // OAuth servers: attach a stored/refreshed token before the first
      // request so connect() doesn't need a browser round-trip when the
      // user already ran `claw mcp login`.
      if (this.cfg.oauth) {
        this.authToken = await ensureToken(this.name, this.cfg.url, this.oauthSpec());
      }
      await this.initializeHttp();
    } else {
      await this.initializeStdio();
    }

    const res = await this.request("tools/list", {});
    const result = res.result as { tools?: McpToolInfo[] } | undefined;
    const tools = (result?.tools ?? []).filter((t) => t.name);
    this.tools.push(...tools);
    return tools;
  }

  /** Call an MCP tool; returns the joined text content. */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = await this.request("tools/call", { name, arguments: args });
    const result = res.result as
      | { content?: Array<{ type?: string; text?: string }>; isError?: boolean }
      | undefined;
    if (res.error) throw new Error(`mcp ${name}: ${res.error.message}`);
    if (result?.isError) {
      const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
      throw new Error(text || `mcp ${name} reported an error`);
    }
    return (result?.content ?? []).map((c) => c.text ?? "").join("\n").trim() || "(no content)";
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // stdio has a child process to politely exit; over http there is nothing
    // to tell (and an in-flight POST here would outlive the server).
    if (this.proc) {
      try {
        this.send({ jsonrpc: "2.0", method: "notifications/exit" });
      } catch {
        /* already gone */
      }
      const p = this.proc;
      setTimeout(() => p.kill(), 200).unref();
      p.stdin.end();
    }
  }

  // ── stdio transport ──────────────────────────────────────────────

  private async initializeStdio(): Promise<void> {
    const cmd = this.cfg.command;
    if (!cmd) throw new Error(`mcp server "${this.name}" needs a command (stdio)`);
    const args = this.cfg.args ?? [];
    const child = spawn(cmd, args, {
      env: { ...process.env, ...this.cfg.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc = child;

    child.stderr.on("data", (d: Buffer) => {
      this.stderrBuf = (this.stderrBuf + d.toString()).slice(-2000);
    });
    child.on("exit", (code) => {
      this.rejectAll(`mcp server "${this.name}" exited (code ${code})`);
    });
    child.on("error", (err) => {
      this.rejectAll(`mcp server "${this.name}" failed to start: ${err.message}`);
    });

    // MCP stdio is newline-delimited JSON-RPC.
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) this.dispatch(line);
      }
    });

    await this.initialize();
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  // ── http transport ───────────────────────────────────────────────

  /** Configured headers with ${VAR} references resolved from the environment,
   * plus the OAuth bearer token when one is available. */
  private httpHeaders(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.cfg.headers ?? {})) {
      out[k] = v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => process.env[name] ?? "");
    }
    if (this.authToken && !out.authorization) {
      out.authorization = `Bearer ${this.authToken}`;
    }
    return out;
  }

  private async initializeHttp(): Promise<void> {
    await this.initialize();
    // The initialized notification is optional over HTTP; some servers want it.
    void this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  private async initialize(): Promise<void> {
    const res = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: { name: "claw", version: "0.1.0" },
    });
    const server = (res.result as { serverInfo?: { name?: string } } | undefined)?.serverInfo;
    void server;
  }

  // ── shared plumbing ──────────────────────────────────────────────

  private async request(method: string, params: Record<string, unknown>): Promise<JsonRpc> {
    const id = nextId++;
    const msg: JsonRpc = { jsonrpc: "2.0", id, method, params };

    if (this.cfg.transport === "http" || this.cfg.url) {
      return await this.httpRoundTrip(id, msg);
    }
    return await this.stdioRoundTrip(id, msg);
  }

  private stdioRoundTrip(id: number, msg: JsonRpc): Promise<JsonRpc> {
    if (!this.proc || this.proc.stdin.destroyed) {
      return Promise.reject(new Error(`mcp server "${this.name}" is not running`));
    }
    return new Promise<JsonRpc>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp request "${msg.method}" timed out`));
      }, 60_000);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.send(msg);
    });
  }

  private async httpRoundTrip(id: number, msg: JsonRpc): Promise<JsonRpc> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60_000);
    try {
      const resp = await fetch(this.cfg.url!, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": PROTOCOL_VERSION,
          ...this.httpHeaders(),
        },
        body: JSON.stringify(msg),
        signal: ac.signal,
      });
      if (resp.status === 401 && this.cfg.oauth && !this.authTried) {
        // Not authorized → run the browser login flow once, then retry.
        this.authTried = true;
        this.authToken = (await mcpOAuthLogin(this.name, this.cfg.url!, this.oauthSpec())).access_token;
        return await this.httpRoundTrip(id, msg);
      }
      if (resp.ok) this.authTried = false; // allow a future re-login on expiry
      if (!resp.ok) {
        const detail = (await resp.text().catch(() => "")).slice(0, 200);
        throw new Error(`HTTP ${resp.status} from mcp "${this.name}": ${detail || resp.statusText}`);
      }
      const ctype = resp.headers.get("content-type") ?? "";
      if (ctype.includes("application/json")) {
        const body = (await resp.json()) as JsonRpc;
        return body;
      }
      // SSE stream: find the event with our id (some servers stream everything).
      let found: JsonRpc | null = null;
      await sseEvents(
        resp,
        (data) => {
          if (found) return;
          if (!data) return;
          try {
            const parsed = JSON.parse(data) as JsonRpc;
            if (parsed.id === id) found = parsed;
          } catch {
            /* ignore non-JSON frames */
          }
        },
        ac.signal,
      );
      if (!found) throw new Error(`mcp "${this.name}": no response for request ${msg.method}`);
      return found;
    } finally {
      clearTimeout(timer);
    }
  }

  private send(msg: JsonRpc): void {
    const line = JSON.stringify(msg);
    if (this.proc) {
      this.proc.stdin.write(line + "\n");
    }
    // Over http, notifications are fire-and-forget POSTs — and so are
    // responses to server-initiated requests (e.g. sampling).
    if (this.cfg.transport === "http" || this.cfg.url) {
      if (msg.id === undefined || msg.method === undefined) {
        fetch(this.cfg.url!, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...this.httpHeaders(),
          },
          body: line,
        }).catch(() => {});
      }
    }
  }

  private dispatch(line: string): void {
    let msg: JsonRpc;
    try {
      msg = JSON.parse(line) as JsonRpc;
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.method === undefined) {
      // A response to one of our requests.
      const cb = this.pending.get(msg.id as number);
      if (cb) {
        this.pending.delete(msg.id as number);
        cb(msg);
      }
      return;
    }
    if (msg.method === "ping" && msg.id !== undefined) {
      this.send({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;
    }
    if (msg.method === "sampling/createMessage" && msg.id !== undefined) {
      // The server is asking CLAW's model to complete a prompt.
      void this.answerSampling(msg.id, msg.params ?? {});
      return;
    }
    if (msg.method && msg.id !== undefined) {
      // Server-initiated request we don't support → polite error.
      this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
    }
    // Notifications are ignored.
  }

  private async answerSampling(id: number | string, params: Record<string, unknown>): Promise<void> {
    const handler = this.handlers.sampling;
    if (!handler) {
      this.send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "sampling not supported by this client" },
      });
      return;
    }
    try {
      const req: SamplingRequest = {
        messages: (params.messages as SamplingMessage[]) ?? [],
        systemPrompt: typeof params.systemPrompt === "string" ? params.systemPrompt : undefined,
        maxTokens: typeof params.maxTokens === "number" ? params.maxTokens : undefined,
      };
      if (!req.messages.length) throw new Error("sampling request has no messages");
      const text = await handler(req);
      this.send({
        jsonrpc: "2.0",
        id,
        result: {
          role: "assistant",
          content: { type: "text", text },
          model: "claw",
          stopReason: "endTurn",
        },
      });
    } catch (err) {
      this.send({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: `sampling failed: ${(err as Error).message}` },
      });
    }
  }

  private rejectAll(reason: string): void {
    for (const [id, cb] of this.pending) {
      this.pending.delete(id);
      cb({ jsonrpc: "2.0", id, error: { code: -32000, message: reason } });
    }
  }

  get lastStderr(): string {
    return this.stderrBuf.trim().split("\n").slice(-3).join("\n");
  }
}

// ── mapping MCP tools into CLAW tools ──────────────────────────────

const READISH = /(^|_)(search|read|list|get|query|fetch|lookup|browse|scrape|crawl|extract|status|info|ping|screenshot)(_|$)/i;

export function sanitizeName(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * Turn an MCP server's tools into CLAW tools. Security: trusted servers →
 * safe; read-only-looking tools → read (no approval, output scanned);
 * everything else → risky (the human approval gate).
 */
export function mcpToolsToClawTools(serverName: string, infos: McpToolInfo[], cfg: McpServerCfg): Tool[] {
  return infos.map((info) => {
    const safe = cfg.trusted === true;
    const readish = !safe && READISH.test(info.name);
    const risk = safe ? "safe" : readish ? "read" : "risky";
    return {
      name: `mcp_${sanitizeName(serverName)}_${sanitizeName(info.name)}`,
      description: `${info.description ?? `Tool "${info.name}"`} (via MCP server "${serverName}")`,
      parameters: (info.inputSchema as Record<string, unknown>) ?? {
        type: "object",
        properties: {},
      },
      risk,
      cacheable: risk === "read",
      async execute(args) {
        const client = mcpClients.get(serverName);
        if (!client) throw new Error(`mcp server "${serverName}" is not connected`);
        return await client.callTool(info.name, args);
      },
    };
  });
}

/** Registry used by the mapped tools to reach their client. */
export const mcpClients = new Map<string, McpClient>();

/**
 * A sampling handler that answers MCP servers with CLAW's own provider: the
 * server's messages are flattened into one prompt, the model completes it
 * with no tools, and the text goes back to the server.
 */
export function providerSamplingHandler(provider: Provider): (req: SamplingRequest) => Promise<string> {
  return async (req) => {
    const parts: string[] = [];
    for (const m of req.messages) {
      const text = typeof m.content === "string" ? m.content : m.content?.text ?? "";
      if (text.trim()) parts.push(text.trim());
    }
    const prompt = parts.join("\n\n");
    if (!prompt) throw new Error("sampling request has no text content");
    const messages: ChatMsg[] = [];
    if (req.systemPrompt) messages.push({ role: "system", content: req.systemPrompt });
    messages.push({ role: "user", content: prompt });
    const res = await provider.chat(messages, []);
    return res.content;
  };
}

export function closeAllMcp(): Promise<void> {
  return Promise.all([...mcpClients.values()].map((c) => c.close())).then(() => undefined);
}
