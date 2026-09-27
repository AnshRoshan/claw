// serve.ts — the second Channel plug. The REPL is `terminal:<sid>`; this is
// `http:<sid>`: a headless, zero-dependency HTTP adapter in front of the SAME
// agent, guards, tools, and ledgers. Many sessions share one loop — exactly
// the multi-chat shape the architecture docs describe. Endpoints:
//
//   GET  /health  → liveness + model info
//   POST /chat    { message, session_id? } → { session_id, answer, … }
//
// Sessions live in a Map (history survives across requests); every request
// is a full TAOR turn with the same guard stack — and since a serve process
// has no TTY, risky tools are denied by the approval gate unless the operator
// runs with -y.

import * as http from "node:http";
import type { ChatMsg, ToolCall } from "./types.ts";
import { Agent } from "./agent.ts";
import { SessionStore } from "./sessions.ts";
import { green, dim, readFileOr, confine, newId } from "./util.ts";
import { loadConfig, updateProjectConfig, updateUserConfig } from "./config.ts";
import { buildModelProvider } from "./providers/factory.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { mcpClients } from "./mcp.ts";

/** The mutable world the server works against. `swapWorkspace` replaces its
 * contents wholesale (new tools, guards, confinement) without a restart. */
export interface ServeWorld {
  agent: Agent;
  workspace: string;
  setupRequired?: boolean;
  approveState?: { autoApprove: boolean; dryRun?: boolean; mode?: "default" | "plan" | "acceptEdits" };
  settings?: {
    allowlist: string[];
    riskyTools: string[];
    hooks: Record<string, boolean>;
    baseURL: string;
  };
  /** Install a headless approval broker (the browser becomes the human gate). */
  setApprovalBridge?: (fn: ((call: ToolCall, sessionKey: string) => Promise<boolean>) | null) => void;
  /** Runtime model swap + introspection for the Models page. */
  setModel?: (name: string) => { provider: string; model: string };
  modelInfo?: () => { provider: string; model: string; aliases: string[]; defaultModel: string };
}

export interface ServeDeps {
  world: ServeWorld;
  /** Where session JSONL files go (~/.claw/sessions). */
  sessionsDir: string;
  host?: string;
  port?: number;
  /** Rebuild the world against a new workspace directory. */
  swapWorkspace?: (dir: string) => { ok: boolean; error?: string };
}

export interface ChatResponse {
  session_id: string;
  answer: string;
  tool_calls: number;
  aborted: boolean;
  model: string;
  usage: { input: number; output: number; calls: number };
}

export function makeServeServer(deps: ServeDeps): http.Server {
  const world = deps.world; // read fresh per request; swapWorkspace mutates it
  const recentsFile = (): string => path.join(path.dirname(deps.sessionsDir), "workspaces.json");
  const readJsonLocal = (p: string): { workspaces?: string[] } => {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8")) as { workspaces?: string[] };
    } catch {
      return {};
    }
  };
  const writeJsonLocal = (p: string, v: { workspaces?: string[] }): void => {
    const json = JSON.stringify(v, null, 2);
    fs.writeFileSync(p, json + "\n");
  };


  const store = new SessionStore(deps.sessionsDir);
  const sessions = new Map<string, { id: string; history: ChatMsg[] }>();

  /* ── operator approval broker ─────────────────────────────────────────
   * In gated modes (default/plan/acceptEdits) a risky tool call blocks the
   * turn and asks the BROWSER: the live SSE stream for that session receives
   * an `approval` event; POST /approve resolves it. No live stream → deny
   * (the old headless contract). Bypass mode never reaches the broker.     */
  const APPROVAL_TIMEOUT_MS = 120_000;
  const streamSends = new Map<string, (obj: Record<string, unknown>) => void>();
  const approvals = new Map<string, {
    resolve: (b: boolean) => void;
    sessionKey: string;
    name: string;
    args: string;
    t0: number;
    send: (obj: Record<string, unknown>) => void;
  }>();
  const installBridge = () => {
    world.setApprovalBridge?.(async (call: ToolCall, sessionKey: string) => {
      const sid = sessionKey.startsWith("http:") ? sessionKey.slice(5) : "";
      const send = streamSends.get(sid);
      if (!send) return false; // no browser to ask — deny, like headless always did
      const id = newId("appr");
      return await new Promise<boolean>((resolve) => {
        const settle = (b: boolean, why: "resolved" | "expired") => {
          clearTimeout(timer);
          approvals.delete(id);
          try {
            send({ type: "approval-resolved", id, approve: b, why });
          } catch {
            /* stream already gone */
          }
          resolve(b);
        };
        const timer = setTimeout(() => settle(false, "expired"), APPROVAL_TIMEOUT_MS);
        approvals.set(id, {
          resolve: (b) => settle(b, "resolved"),
          sessionKey: sid,
          name: call.function.name,
          args: call.function.arguments,
          t0: Date.now(),
          send,
        });
        send({ type: "approval", id, session_id: sid, name: call.function.name, args: call.function.arguments, timeout_ms: APPROVAL_TIMEOUT_MS });
      });
    });
  };
  installBridge();

  const getSession = (requested: string | undefined): { id: string; history: ChatMsg[] } => {
    if (requested && sessions.has(requested)) return sessions.get(requested)!;
    let history: ChatMsg[];
    let id: string;
    if (requested && store.load(requested).length > 0) {
      // Resume a persisted session by id.
      id = requested;
      history = store.load(id);
    } else {
      const fresh = store.create(world.agent.provider.model, "http", world.workspace);
      id = fresh.id;
      history = [{ role: "system", content: Agent.systemPrompt(world.workspace) }];
    }
    const entry = { id, history };
    sessions.set(id, entry);
    return entry;
  };

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? "/";
    if (req.method === "GET" && (url === "/health")) {
      json(res, 200, {
        ok: true,
        agent: "claw",
        model: world.agent.provider.model,
        workspace: world.workspace,
        sessions: sessions.size,
      });
      return;
    }
    if (req.method === "GET" && (url === "/" || url === "/ui" || url === "/app")) {
      // The browser channel: the local web app (web/index.html) — sessions
      // sidebar, streaming chat, and the tool-trace timeline. Everything it
      // renders is a projection of the same event stream the terminal sees.
      const page = readFileOr(new URL("../web/index.html", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")) ?? uiPage(world.agent.provider.model, world.workspace);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(page) });
      res.end(page);
      return;
    }
    if (req.method === "GET" && url === "/sessions") {
      // Session list for the web app's sidebar.
      json(res, 200, {
        sessions: store.list().slice(0, 50).map((m) => ({
          id: m.id, title: m.title ?? m.id, model: m.model, turns: m.turns, createdAt: m.createdAt,
        })),
      });
      return;
    }
    if (req.method === "GET" && url?.startsWith("/history")) {
      // The trajectory projection: every message AND event, in log order.
      const sid = new URL(url, "http://x").searchParams.get("session_id") ?? "";
      const records = sid ? store.loadRaw(sid) : [];
      json(res, 200, {
        session_id: sid,
        model: world.agent.provider.model,
        records,
        messages: records
          .filter((r) => typeof r.role === "string" && r.role !== "system")
          .filter((r) => !("type" in r)),
      });
      return;
    }
    if (req.method === "GET" && url?.startsWith("/search")) {
      // Search across every session: titles + full log text.
      const q = (new URL(url, "http://x").searchParams.get("q") ?? "").trim().toLowerCase();
      if (!q) {
        json(res, 200, { results: [] });
        return;
      }
      const results: Array<{ id: string; title: string; snippet: string }> = [];
      const ws = /\s+/g;
      for (const meta of store.list()) {
        const raw = store.rawText(meta.id).toLowerCase();
        const hay = (meta.title ?? "") + "\n" + raw;
        const idx = hay.indexOf(q);
        if (idx === -1) continue;
        const rawIdx = Math.max(0, idx - 80);
        results.push({
          id: meta.id,
          title: meta.title ?? meta.id,
          snippet: "…" + raw.slice(rawIdx, rawIdx + 180).replace(/\s+/g, " ") + "…",
        });
        if (results.length >= 20) break;
      }
      json(res, 200, { results });
      return;
    }
    if (req.method === "POST" && (url === "/chat" || url === "/v1/chat")) {
      let body = "";
      for await (const chunk of req) body += chunk;
      let message = "";
      let sid: string | undefined;
      let stream = false;
      try {
        const parsed = JSON.parse(body) as { message?: unknown; session_id?: unknown; stream?: unknown };
        message = String(parsed.message ?? "").trim();
        sid = typeof parsed.session_id === "string" ? parsed.session_id : undefined;
        stream = parsed.stream === true;
      } catch {
        json(res, 400, { error: "body must be JSON: { message, session_id?, stream? }" });
        return;
      }
      if (!message) {
        json(res, 400, { error: "missing `message`" });
        return;
      }

      if (world.setupRequired) {
        json(res, 428, { error: "setup_required", message: "No API key configured — open the workbench to connect a provider." });
        return;
      }

      const session = getSession(sid);
      session.history.push({ role: "user", content: message });
      store.append(session.id, { role: "user", content: message });
      // Title the session from its first message (OpenCode-style).
      if (!store.meta(session.id)?.title) {
        store.updateMeta(session.id, { title: message.slice(0, 60) + (message.length > 60 ? "…" : "") });
      }
      const prevLen = session.history.length;

      const before = world.agent.ledger.totals;

      // Streamed mode: SSE frames — text deltas live, then one `done` event
      // carrying the same payload the non-streamed response would return.
      if (stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        let closed = false;
        req.on("close", () => (closed = true));
        const send = (obj: unknown) => {
          if (!closed) res.write(`data: ${JSON.stringify(obj)}\n\n`);
        };
        streamSends.set(session.id, send as (o: Record<string, unknown>) => void);
        try {
          let reasoningBuf = "";
          const outcome = await world.agent.runTurn(`http:${session.id}`, session.history, {
            onText: (d) => send({ type: "text", delta: d }),
            onReasoning: (d) => {
              reasoningBuf += d;
              send({ type: "reasoning", delta: d });
            },
            onEvent: (e) => {
              send({ type: "tool", ...e });
              // The trajectory: tool activity lives in the session log too.
              store.appendRaw(session.id, { kind: e.kind, name: e.name, detail: e.detail, ok: e.ok, ms: e.ms });
            },
          });
          const after = world.agent.ledger.totals;
          for (const m of session.history.slice(prevLen)) store.append(session.id, m);
          if (reasoningBuf.trim()) {
            store.appendRaw(session.id, { kind: "reasoning", text: reasoningBuf.slice(0, 20_000) });
          }
          store.bumpTurns(session.id, outcome.history.filter((m) => m.role === "user").length);
          send({ type: "done", ...buildPayload(session.id, outcome, world.agent, before, after) });
        } catch (err) {
          send({ type: "error", error: (err as Error).message });
        } finally {
          streamSends.delete(session.id);
          for (const [id, a] of approvals) if (a.sessionKey === session.id) { a.resolve(false); }
        }
        res.end();
        return;
      }

      const events: Array<Record<string, unknown>> = [];
      const outcome = await world.agent.runTurn(`http:${session.id}`, session.history, {
        onEvent: (e) => events.push({ kind: e.kind, name: e.name, detail: e.detail, ok: e.ok, ms: e.ms, full: e.full }),
      });
      const after = world.agent.ledger.totals;

      // runTurn mutates session.history in place — persist what the turn added.
      for (const m of session.history.slice(prevLen)) store.append(session.id, m);
      for (const e of events) store.appendRaw(session.id, e);
      store.bumpTurns(session.id, outcome.history.filter((m) => m.role === "user").length);

      json(res, 200, buildPayload(session.id, outcome, world.agent, before, after));
      return;
    }
    if (req.method === "GET" && url === "/status") {
      // One call the workbench makes on load: everything the shell displays.
      json(res, 200, {
        ok: true,
        model: world.agent.provider.model,
        provider: world.agent.provider.name,
        workspace: world.workspace,
        mode: world.approveState?.mode ?? (world.approveState?.autoApprove ? "bypass" : "default"),
        configured: !world.setupRequired,
        sessions: sessions.size,
        pending_approvals: approvals.size,
        mcp: [...mcpClients.entries()].map(([name, c]) => ({
          name,
          tools: c.tools.map((t) => t.name),
          transport: c.cfg.url ? "http" : "stdio",
        })),
      });
      return;
    }
    if (req.method === "GET" && url?.startsWith("/files")) {
      // Workspace file browser (read-only, confined).
      const dir = new URL(url, "http://x").searchParams.get("path") || ".";
      try {
        const abs = confine(world.workspace, dir);
        const entries = fs.readdirSync(abs, { withFileTypes: true }).filter((e) => !e.name.startsWith(".") && e.name !== "node_modules");
        entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        json(res, 200, {
          path: dir,
          entries: entries.slice(0, 500).map((e) => ({ name: e.name, dir: e.isDirectory() })),
        });
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
      return;
    }
    if (req.method === "POST" && url === "/upload") {
      // Attach a file to the workspace so the agent can read it (@-tag it).
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const { name, content } = JSON.parse(body) as { name?: string; content?: string };
        const safeName = path.basename(String(name ?? "attachment.bin")).replace(/[^A-Za-z0-9._-]/g, "_");
        if (!safeName || safeName === ".") throw new Error("bad file name");
        const buf = Buffer.from(String(content ?? ""), "base64");
        if (buf.length > 10 * 1024 * 1024) throw new Error("attachment exceeds 10 MB");
        const dir = confine(world.workspace, "attachments");
        fs.mkdirSync(dir, { recursive: true });
        const rel = "attachments/" + safeName;
        fs.writeFileSync(path.join(dir, safeName), buf);
        json(res, 200, { path: rel, bytes: buf.length });
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
      return;
    }
    if (req.method === "POST" && url === "/mode") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const { mode } = JSON.parse(body) as { mode?: string };
        if (!world.approveState) throw new Error("approveState not wired — restart serve from the CLI");
        if (mode === "bypass") {
          world.approveState.autoApprove = true;
          world.approveState.mode = undefined;
        } else if (mode === "default" || mode === "plan" || mode === "acceptEdits") {
          world.approveState.autoApprove = false;
          world.approveState.mode = mode;
        } else {
          throw new Error("mode must be default | plan | acceptEdits | bypass");
        }
        json(res, 200, { mode: world.approveState.mode ?? "bypass" });
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
      return;
    }
    if (req.method === "GET" && url === "/approvals") {
      json(res, 200, {
        pending: [...approvals.entries()].map(([id, a]) => ({
          id,
          session_id: a.sessionKey,
          name: a.name,
          args: a.args,
          waiting_ms: Date.now() - a.t0,
        })),
      });
      return;
    }
    if (req.method === "POST" && url === "/approve") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const { id, approve } = JSON.parse(body) as { id?: string; approve?: boolean };
        const a = id ? approvals.get(id) : undefined;
        if (!a) {
          json(res, 404, { error: "no pending approval with that id (it may have expired)" });
          return;
        }
        a.resolve(approve === true);
        json(res, 200, { ok: true, id, approve: approve === true });
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
      return;
    }
    if (req.method === "GET" && url === "/memory") {
      // The project memory file the agent obeys every session: CLAW.md.
      const p = path.join(world.workspace, "CLAW.md");
      json(res, 200, { path: "CLAW.md", exists: fs.existsSync(p), content: readFileOr(p) ?? "" });
      return;
    }
    if (req.method === "POST" && url === "/memory") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const { content } = JSON.parse(body) as { content?: unknown };
        if (typeof content !== "string") throw new Error("body must be JSON: { content }");
        const p = confine(world.workspace, "CLAW.md");
        fs.writeFileSync(p, content.slice(0, 200_000), "utf8");
        json(res, 200, { ok: true, bytes: content.length });
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
      return;
    }
    if (req.method === "GET" && url === "/models") {
      const info = world.modelInfo?.() ?? { provider: world.agent.provider.name, model: world.agent.provider.model, aliases: [], defaultModel: world.agent.provider.model };
      json(res, 200, info);
      return;
    }
    if (req.method === "POST" && url === "/models") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const { model } = JSON.parse(body) as { model?: string };
        if (!model?.trim()) throw new Error("body must be JSON: { model }");
        if (!world.setModel) throw new Error("model swap not wired — restart serve from the CLI");
        const next = world.setModel(model.trim());
        json(res, 200, { ok: true, ...next });
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
      return;
    }
    if (req.method === "GET" && url === "/skills") {
      // Custom slash commands (.claw/commands/*.md) + instructions presence.
      const commands: Array<{ name: string; source: string }> = [];
      for (const [scope, dir] of [
        ["workspace", path.join(world.workspace, ".claw", "commands")],
        ["user", path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".claw", "commands")],
      ] as const) {
        try {
          for (const f of fs.readdirSync(dir)) {
            if (f.endsWith(".md")) commands.push({ name: f.slice(0, -3), source: scope });
          }
        } catch { /* no dir at this scope */ }
      }
      json(res, 200, {
        commands,
        instructions: fs.existsSync(path.join(world.workspace, "CLAW.md"))
          ? "CLAW.md"
          : fs.existsSync(path.join(world.workspace, "AGENTS.md"))
            ? "AGENTS.md"
            : null,
      });
      return;
    }
    if (req.method === "GET" && url === "/setup") {
      // Provider presets for the onboarding screen (OpenCode-style).
      json(res, 200, {
        configured: !world.setupRequired,
        providers: [
          { id: "openai", label: "OpenAI", baseURL: "https://api.openai.com/v1", models: "gpt-4o, gpt-4o-mini, o3-mini, …", needsKey: true },
          { id: "anthropic", label: "Anthropic", baseURL: "", models: "claude-sonnet-4-5, claude-opus-4, claude-haiku-4, …", needsKey: true },
          { id: "openrouter", label: "OpenRouter", baseURL: "https://openrouter.ai/api/v1", models: "hundreds of models — any slug", needsKey: true },
          { id: "ollama", label: "Ollama (local, free)", baseURL: "http://127.0.0.1:11434/v1", models: "qwen2.5-coder:7b, llama3.2, …", needsKey: false },
          { id: "custom", label: "Custom OpenAI-compatible", baseURL: "", models: "whatever your endpoint serves", needsKey: false },
        ],
      });
      return;
    }
    if (req.method === "POST" && url === "/setup") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const { provider, apiKey, baseURL, model } = JSON.parse(body) as {
          provider?: string; apiKey?: string; baseURL?: string; model?: string;
        };
        const presets: Record<string, { url: string; type: "openai" | "anthropic" }> = {
          openai: { url: "https://api.openai.com/v1", type: "openai" },
          anthropic: { url: "", type: "anthropic" },
          openrouter: { url: "https://openrouter.ai/api/v1", type: "openai" },
          ollama: { url: "http://127.0.0.1:11434/v1", type: "openai" },
          custom: { url: "", type: "openai" },
        };
        const preset = presets[provider ?? ""];
        if (!preset) throw new Error("unknown provider — pick one of openai, anthropic, openrouter, ollama, custom");
        const finalURL = (baseURL ?? "").trim() || preset.url;
        if (provider === "custom" && !finalURL) throw new Error("custom providers need a base URL");
        if (preset.type === "anthropic" && !apiKey?.trim()) throw new Error("anthropic needs an API key");
        if (!["ollama", "custom"].includes(provider ?? "") && !apiKey?.trim()) throw new Error("this provider needs an API key");
        if (!model?.trim()) throw new Error("a model name is required");

        // Persist exactly the way the layered config has always worked:
        // write the user config, then verify the merged result actually
        // took (a project .claw.json outranks it) and fall through to the
        // project layer if it did not.
        const patch = {
          baseURL: finalURL,
          apiKey: apiKey?.trim() || "",
          model: model.trim(),
          providerType: preset.type,
          autoApprove: false, // the browser is the gate now: gated modes push approvals to the workbench
        };
        updateUserConfig(patch);
        const merged = loadConfig();
        if (merged.model !== patch.model || merged.baseURL !== patch.baseURL) {
          updateProjectConfig(patch);
        }

        // Rebuild the provider from the saved config and swap it live.
        const cfg = loadConfig();
        const next = buildModelProvider(cfg.model, cfg.models, {
          baseURL: cfg.baseURL,
          defaultModel: cfg.model,
          defaultKey: cfg.apiKey,
          anthropic: cfg.providerType === "anthropic",
        });
        world.agent.swapProvider(next);
        world.setupRequired = next.name.includes("mock");
        logLineSafe("done", `provider connected: ${next.name} / ${next.model}`);
        json(res, 200, {
          ok: true,
          configured: !world.setupRequired,
          provider: next.name,
          model: next.model,
        });
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
      return;
    }
    if (req.method === "GET" && url?.startsWith("/file")) {
      // Read ONE workspace file for the Files page preview (confined, capped).
      const rel = new URL(url, "http://x").searchParams.get("path") || "";
      try {
        if (!rel) throw new Error("missing ?path");
        const abs = confine(world.workspace, rel);
        const stat = fs.statSync(abs, { throwIfNoEntry: false });
        if (!stat?.isFile()) throw new Error(`no such file: ${rel}`);
        const buf = fs.readFileSync(abs);
        if (buf.subarray(0, 8192).includes(0)) {
          json(res, 200, { path: rel, binary: true, size: stat.size });
          return;
        }
        const text = buf.toString("utf8");
        json(res, 200, { path: rel, size: stat.size, truncated: text.length > 200_000, content: text.slice(0, 200_000) });
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
      return;
    }
    if (req.method === "GET" && url?.startsWith("/fs")) {
      // Machine-wide directory browser for the workspace picker (local
      // operator tool — this is how you point claw at a new project).
      const dir = new URL(url, "http://x").searchParams.get("path") || "";
      try {
        const target = path.resolve(dir || (process.env.USERPROFILE ?? process.env.HOME ?? "/"));
        const entries = fs.readdirSync(target, { withFileTypes: true });
        entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        json(res, 200, {
          path: target,
          parent: path.dirname(target),
          entries: entries.slice(0, 400).map((e) => ({ name: e.name, dir: e.isDirectory() })),
        });
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
      return;
    }
    if (req.method === "GET" && url === "/workspaces") {
      const recents = readJsonLocal(recentsFile());
      json(res, 200, { current: world.workspace, recents: recents.workspaces ?? [] });
      return;
    }
    if (req.method === "POST" && url === "/workspace") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        if (!deps.swapWorkspace) throw new Error("this server cannot swap workspaces (no swapWorkspace wired)");
        const { path: dir } = JSON.parse(body) as { path?: string };
        const abs = path.resolve(String(dir ?? "").trim());
        if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error("not a directory: " + abs);
        const r = deps.swapWorkspace(abs);
        if (!r.ok) throw new Error(r.error ?? "swap failed");
        sessions.clear(); // in-memory histories belong to the old workspace
        const rec = readJsonLocal(recentsFile());
        rec.workspaces = [abs, ...(rec.workspaces ?? []).filter((x) => x !== abs)].slice(0, 8);
        writeJsonLocal(recentsFile(), rec);
        json(res, 200, { ok: true, workspace: world.workspace, model: world.agent.provider.model });
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
      return;
    }
    if (req.method === "GET" && url === "/settings") {
      json(res, 200, {
        model: world.agent.provider.model,
        provider: world.agent.provider.name,
        workspace: world.workspace,
        mode: world.approveState?.mode ?? (world.approveState?.autoApprove ? "bypass" : "default"),
        allowlist: world.settings?.allowlist ?? [],
        riskyTools: world.settings?.riskyTools ?? [],
        hooks: world.settings?.hooks ?? {},
        baseURL: world.settings?.baseURL ?? "",
        autoApprove: world.approveState?.autoApprove ?? false,
      });
      return;
    }
    json(res, 404, { error: "not found — try GET /health or POST /chat" });
  });

  return server;
}

type Outcome = Awaited<ReturnType<Agent["runTurn"]>>;

function logLineSafe(kind: string, msg: string): void {
  console.log(dim("[" + kind + "] " + msg));
}

function buildPayload(
  sessionId: string,
  outcome: Outcome,
  agent: Agent,
  before: { input: number; output: number; calls: number },
  after: { input: number; output: number; calls: number },
): ChatResponse {
  return {
    session_id: sessionId,
    answer: outcome.answer,
    tool_calls: outcome.toolCallsMade,
    aborted: outcome.aborted,
    model: agent.provider.model,
    usage: {
      input: after.input - before.input,
      output: after.output - before.output,
      calls: after.calls - before.calls,
    },
  };
}

/** Start the server and log the URL; resolves with the bound port. */
export function startServe(deps: ServeDeps): Promise<number> {
  const server = makeServeServer(deps);
  return new Promise<number>((resolve, reject) => {
    server.on("error", reject);
    server.listen(deps.port ?? 0, deps.host ?? "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : (deps.port ?? 0);
      console.log(green(`  claw serve listening on http://${deps.host ?? "127.0.0.1"}:${port}`));
      console.log(dim("    POST /chat  {\"message\": \"...\", \"session_id\": \"...\"}"));
      console.log(dim("    GET  /health"));
      console.log(dim("  Ctrl+C to stop"));
      resolve(port);
    });
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
  res.end(data);
}

/** Escape text for safe innerHTML insertion in the chat page. */
function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * The built-in web chat page — plain HTML/CSS/JS, no framework, no CDN.
 * It talks to the SAME /chat endpoint as every other channel and keeps the
 * session id in the page (so "New session" is just forgetting it).
 */
function uiPage(model: string, workspace: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>claw — ${escapeHtml(model)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.6 ui-monospace, Consolas, monospace; background: #0d1117; color: #e6edf3; display: flex; flex-direction: column; height: 100vh; }
  header { display: flex; align-items: baseline; gap: 12px; padding: 10px 16px; border-bottom: 1px solid #21262d; }
  header h1 { font-size: 15px; margin: 0; color: #7ee787; }
  header span { color: #8b949e; font-size: 12px; }
  header button { margin-left: auto; background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 4px 10px; cursor: pointer; font: inherit; font-size: 12px; }
  #chat { flex: 1; overflow-y: auto; padding: 16px; }
  .msg { margin: 0 0 14px; white-space: pre-wrap; word-wrap: break-word; }
  .msg.you { color: #79c0ff; }
  .msg.you::before { content: "you ❯ "; color: #388bfd; }
  .msg.claw { color: #e6edf3; }
  .msg.claw::before { content: "claw ❯ "; color: #7ee787; }
  .msg.err { color: #ffa198; }
  .msg small { display: block; color: #8b949e; margin-top: 4px; }
  .trace { color: #8b949e; font-size: 12px; margin: -8px 0 10px; white-space: pre-wrap; }
  pre.code { background: #161b22; border: 1px solid #21262d; border-radius: 6px; padding: 8px 10px; overflow-x: auto; font-size: 12px; }
  code { background: #161b22; border-radius: 4px; padding: 1px 5px; font-size: 12px; }
  form { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid #21262d; }
  input { flex: 1; background: #161b22; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 10px 12px; font: inherit; }
  input:focus { outline: none; border-color: #388bfd; }
  button.send { background: #238636; color: #fff; border: 0; border-radius: 6px; padding: 10px 18px; cursor: pointer; font: inherit; }
  button.send:disabled { opacity: .5; cursor: wait; }
</style>
</head>
<body>
<header>
  <h1>claw</h1>
  <span>${escapeHtml(model)} · ${escapeHtml(workspace)}</span>
  <button id="reset" type="button">+ new session</button>
</header>
<div id="chat"></div>
<form id="f">
  <input id="m" placeholder="Ask CLAW to work in this workspace…" autocomplete="off" autofocus>
  <button class="send" type="submit">send</button>
</form>
<script>
  const chat = document.getElementById("chat");
  const form = document.getElementById("f");
  const input = document.getElementById("m");
  const sendBtn = form.querySelector(".send");
  let sessionId = null; // server creates one on first message

  // Minimal markdown: escape everything, then style fences and inline code.
  // (No literal backticks here — this script lives inside a template literal.)
  var TICK = String.fromCharCode(96);
  var FENCE = TICK + TICK + TICK;
  function md(text) {
    var out = "";
    var parts = text.split(FENCE);
    for (var i = 0; i < parts.length; i++) {
      var esc = escapeHtml(parts[i]);
      if (i % 2 === 1) {
        var nl = esc.indexOf("\\n");
        out += '<pre class="code">' + (nl >= 0 ? esc.slice(nl + 1) : esc) + "</pre>";
      } else {
        out += esc.replace(new RegExp(TICK + "([^" + TICK + "]+)" + TICK, "g"), "<code>$1</code>");
      }
    }
    return out || "&nbsp;";
  }
  function escapeHtml(s) {
    return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  }

  function add(cls, text, meta) {
    const el = document.createElement("div");
    el.className = "msg " + cls;
    el.textContent = text;
    if (meta) { const s = document.createElement("small"); s.textContent = meta; el.appendChild(s); }
    chat.appendChild(el);
    chat.scrollTop = chat.scrollHeight;
    return el;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (!message) return;
    input.value = "";
    add("you", message);
    sendBtn.disabled = true;
    const live = add("claw", "");
    try {
      const r = await fetch("/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, session_id: sessionId, stream: true }),
      });
      const ctype = r.headers.get("content-type") || "";
      if (r.body && ctype.includes("text/event-stream")) {
        // SSE: text deltas appear live, then one done event with the payload.
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "", text = "", final = null, err = null, meta = null;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const frames = buf.split("\\n\\n");
          buf = frames.pop() || "";
          for (const frame of frames) {
            const line = frame.split("\\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            let j; try { j = JSON.parse(line.slice(5)); } catch { continue; }
            if (j.type === "text") { text += j.delta; live.innerHTML = md(text); chat.scrollTop = chat.scrollHeight; }
            if (j.type === "tool") {
              const t = document.createElement("div");
              t.className = "trace";
              t.textContent = (j.kind === "tool-start" ? "▶ " : (j.ok ? "◀ " : "✗ ")) + j.name + "  " + (j.detail || "");
              chat.appendChild(t);
              chat.scrollTop = chat.scrollHeight;
            }
            if (j.type === "done") final = j;
            if (j.type === "error") err = j.error;
          }
        }
        live.remove();
        if (err) add("err", err);
        else if (final) {
          if (final.session_id) sessionId = final.session_id;
          const el = add(final.aborted ? "err" : "claw", "",
              final.tool_calls ? final.tool_calls + " tool call" + (final.tool_calls === 1 ? "" : "s") + " · in " + final.usage.input + " · out " + final.usage.output : null);
          el.innerHTML = md(final.answer || "(empty)");
        }
      } else {
        // Non-streaming fallback (plain JSON).
        const j = await r.json();
        live.remove();
        if (j.session_id) sessionId = j.session_id;
        add(j.aborted ? "err" : "claw", j.answer || j.error || "(empty)", null);
      }
    } catch (err) {
      live.remove();
      add("err", "request failed: " + err.message);
    }
    sendBtn.disabled = false;
    input.focus();
  });

  document.getElementById("reset").addEventListener("click", () => {
    sessionId = null;
    chat.replaceChildren();
    add("claw", "Fresh session — the next message starts over.");
    input.focus();
  });
</script>
</body>
</html>`;
}
