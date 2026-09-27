// selfcheck.ts — runnable assertions over every organ of CLAW: the loop, the
// guards, the caches, the session lock, and both provider wire adapters
// (streamed against local fake servers so no network is needed).

import * as http from "node:http";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import type { ChatMsg, Provider, ProviderResult, Tool, Usage } from "./types.ts";
import { Agent } from "./agent.ts";
import { RouterProvider } from "./providers/router.ts";
import { Ledger } from "./cost.ts";
import { makeDelegateTool, type DelegateCtx } from "./subagent.ts";
import { approvalGuard, loopDetectGuard, outputCapGuard, pathConfineGuard, secretScanGuard, shellAllowlistGuard } from "./guards.ts";
import { OpenAIProvider } from "./providers/openai.ts";
import { AnthropicProvider } from "./providers/anthropic.ts";
import { globToRegExp } from "./tools/search.ts";
import { makeCalcTool } from "./tools/calc.ts";
import { parseDuckDuckGo } from "./tools/web_search.ts";
import { McpClient, mcpClients, mcpToolsToClawTools } from "./mcp.ts";
import { makeGitTools, createWorktree, isGitRepo, removeWorktree } from "./tools/git.ts";
import { makeShellTools } from "./tools/shell.ts";
import { makeFsTools } from "./tools/fs.ts";
import { makeEditTool } from "./tools/edit.ts";
import { makeSearchTools } from "./tools/search.ts";
import { makeServeServer } from "./serve.ts";
import { findCommand, listCommands, renderCommand } from "./commands.ts";
import { SessionStore } from "./sessions.ts";
import { matchesAllowlist, parseJsonArgs } from "./util.ts";
import { writeConfigFile } from "./config.ts";
import { makeTodoTool } from "./tools/todo.ts";
import { userHooksGuard } from "./guards.ts";
import { forgetToken, loadToken, refreshAccessToken, saveToken, setOpenBrowserHook, validToken } from "./oauth.ts";
import { appendMemoryNote, completeSlash, contextEstimate, exportMarkdown, BUILTIN_SLASH } from "./repl.ts";
import { withRetry, RetryableError, isRetryableStatus } from "./util.ts";

function fail(msg: string): never {
  console.error("  FAIL: " + msg);
  process.exit(1);
}

function ok(name: string): void {
  console.log("  ✓ " + name);
}

function call(name: string, args: Record<string, unknown>) {
  return {
    id: "c1",
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  };
}

/**
 * A scripted provider: step 0 emits a tool call, step 1 answers. Decides by
 * the last message (tool result present → answer), so EVERY turn exercises
 * the full tool→observe→answer path — exactly how the real mock behaves.
 */
class Scripted implements Provider {
  readonly streamable = false;
  readonly name = "scripted";
  readonly model: string;
  private steps: Array<(msgs: ChatMsg[]) => ProviderResult>;

  constructor(model: string, steps: Array<(msgs: ChatMsg[]) => ProviderResult>) {
    this.model = model;
    this.steps = steps;
  }

  async chat(msgs: ChatMsg[]): Promise<ProviderResult> {
    const last = msgs[msgs.length - 1];
    return last.role === "tool" ? this.steps[1](msgs) : this.steps[0](msgs);
  }
}

function lastToolResult(msgs: ChatMsg[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "tool") return msgs[i].content;
  }
  return "(none)";
}

export async function runSelfCheck(): Promise<void> {
  console.log("claw selfcheck — " + process.version + "\n");

  // ── router: failover + round-robin across backends ──
  const throwing: Provider = {
    name: "broken",
    model: "broken",
    streamable: false,
    chat: async () => {
      throw new Error("backend down");
    },
  };
  const good = new Scripted("good", [() => ({ content: "from good", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } })]);
  const router = new RouterProvider([throwing, good], "failover");
  const routed = await router.chat([{ role: "user", content: "hi" }], []);
  if (routed.content !== "from good") fail(`router failover should reach the good backend, got ${routed.content}`);
  if (router.statuses[0].errors !== 1 || router.statuses[0].ok) fail("router should mark the broken backend failed");
  ok("router failover: broken backend → healthy backend");

  const a = new Scripted("a", [() => ({ content: "A", toolCalls: [], usage: null })]);
  const b = new Scripted("b", [() => ({ content: "B", toolCalls: [], usage: null })]);
  const rr = new RouterProvider([a, b], "roundrobin");
  const c1 = await rr.chat([{ role: "user", content: "x" }], []);
  const c2 = await rr.chat([{ role: "user", content: "x" }], []);
  if (c1.content === c2.content) fail(`roundrobin should alternate backends, got ${c1.content} twice`);
  ok("router round-robin alternates backends");

  // ── router budgets: a spent backend is skipped until the others are used ──
  const cheap = new Scripted("cheap", [() => ({ content: "cheap", toolCalls: [], usage: { inputTokens: 100, outputTokens: 10 } })]);
  const pricey = new Scripted("pricey", [() => ({ content: "pricey", toolCalls: [], usage: { inputTokens: 100, outputTokens: 10 } })]);
  const budgeted = new RouterProvider([cheap, pricey], "failover", [], [{ maxCalls: 1 }, undefined]);
  const rb1 = await budgeted.chat([{ role: "user", content: "x" }], []);
  const rb2 = await budgeted.chat([{ role: "user", content: "x" }], []);
  const rb3 = await budgeted.chat([{ role: "user", content: "x" }], []);
  if (rb1.content !== "cheap") fail(`first call should hit the budgeted backend, got ${rb1.content}`);
  if (rb2.content !== "pricey" || rb3.content !== "pricey") fail("spent backend should be skipped while the other is fresh");
  if (budgeted.statuses[0].spent.calls !== 1 || budgeted.statuses[1].spent.calls !== 0) {
    fail(`budget spend not tracked correctly: ${JSON.stringify(budgeted.statuses.map((s) => s.spent))}`);
  }
  if (!/SPENT/.test(budgeted.report()[0])) fail("report should flag the spent backend");
  ok("router budgets: spent backend skipped, spend tracked in /backends");

  // ── sub-agents: delegate end-to-end, depth cap, timeout, ledger merge ──
  const taskAware: Provider = {
    name: "task-aware",
    model: "ta",
    streamable: false,
    async chat(msgs) {
      const lastUser = [...msgs].reverse().find((m) => m.role === "user");
      if (lastUser?.content.includes("compute 42")) {
        return { content: "sub result: 42", toolCalls: [], usage: { inputTokens: 5, outputTokens: 7 } };
      }
      if (msgs[msgs.length - 1].role === "tool") {
        return { content: "final: " + lastToolResult(msgs), toolCalls: [], usage: null };
      }
      return { content: "", toolCalls: [call("delegate", { task: "compute 42" })], usage: null };
    },
  };

  const parentLedger = new Ledger();
  let makeToolset: (ctx: DelegateCtx) => Tool[];
  makeToolset = (ctx: DelegateCtx) => [
    makeDelegateTool(
      {
        provider: taskAware,
        makeToolset,
        guards: [],
        maxDepth: 2,
        timeoutMs: 5_000,
        maxIterations: 5,
        compactAt: 50,
        verbose: false,
        workspace: process.cwd(),
      },
      ctx,
    ),
  ];
  const topCtx: DelegateCtx = { depth: 0, maxDepth: 2, counter: 0, parentKey: "selfcheck", ledger: parentLedger };
  const parentAgent = new Agent(
    taskAware,
    makeToolset(topCtx),
    { maxIterations: 5, verbose: false, compactAt: 50, log: () => {}, onText: () => {} },
    parentLedger,
  );
  const pTurn = await parentAgent.runTurn("selfcheck", [
    { role: "system", content: "s" },
    { role: "user", content: "parent task" },
  ]);
  if (!pTurn.answer.includes("sub result: 42")) fail(`delegate should surface the sub-agent result, got ${pTurn.answer}`);
  if (pTurn.answer.includes("sub-agent #1")) {
    ok("sub-agent handoff: parent → sub-agent → receipt + result");
  } else {
    fail("delegate receipt missing");
  }
  if (parentLedger.totals.input < 5 || parentLedger.totals.output < 7) {
    fail(`sub-agent usage should merge into the parent ledger, got ${JSON.stringify(parentLedger.totals)}`);
  }
  ok("sub-agent ledger merges into parent");

  // depth cap: a sub-agent that tries to delegate again is told to stop
  const shallow: Provider = {
    name: "shallow",
    model: "sh",
    streamable: false,
    async chat(msgs) {
      if (msgs[msgs.length - 1].role === "tool") {
        return { content: "final: " + lastToolResult(msgs), toolCalls: [], usage: null };
      }
      return { content: "", toolCalls: [call("delegate", { task: "recurse" })], usage: null };
    },
  };
  let mt2: (ctx: DelegateCtx) => Tool[];
  mt2 = (ctx: DelegateCtx) => [
    makeDelegateTool({ provider: shallow, makeToolset: mt2, guards: [], maxDepth: 0, timeoutMs: 2_000, maxIterations: 4, compactAt: 50, verbose: false, workspace: process.cwd() }, ctx),
  ];
  const capAgent = new Agent(shallow, mt2({ depth: 0, maxDepth: 0, counter: 0, parentKey: "cap", ledger: new Ledger() }), {
    maxIterations: 4,
    verbose: false,
    compactAt: 50,
    log: () => {},
    onText: () => {},
  });
  const capTurn = await capAgent.runTurn("cap", [{ role: "system", content: "s" }, { role: "user", content: "go" }]);
  if (!capTurn.answer.includes("depth limit")) fail(`depth cap should stop delegation, got ${capTurn.answer}`);
  ok("sub-agent depth cap: runaway delegation is stopped");

  // timeout: a slow sub-agent is aborted and the workflow closes cleanly
  const slowParent: Provider = {
    name: "slow-parent",
    model: "sp",
    streamable: false,
    async chat(msgs, _tools, opts) {
      const lastUser = [...msgs].reverse().find((m) => m.role === "user");
      if (lastUser?.content.includes("slow task")) {
        // The sub-agent's model hangs until the delegate timeout aborts it.
        return await new Promise<ProviderResult>((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => reject(new Error("aborted by timeout")));
        });
      }
      if (msgs[msgs.length - 1].role === "tool") {
        return { content: "final: " + lastToolResult(msgs), toolCalls: [], usage: null };
      }
      return { content: "", toolCalls: [call("delegate", { task: "slow task", timeout_ms: 30 })], usage: null };
    },
  };
  let mt3: (ctx: DelegateCtx) => Tool[];
  mt3 = (ctx: DelegateCtx) => [
    makeDelegateTool(
      {
        provider: slowParent,
        makeToolset: mt3,
        guards: [],
        maxDepth: 1,
        timeoutMs: 5_000,
        maxIterations: 4,
        compactAt: 50,
        verbose: false,
        workspace: process.cwd(),
      },
      ctx,
    ),
  ];
  const timeAgent = new Agent(
    slowParent,
    mt3({ depth: 0, maxDepth: 1, counter: 0, parentKey: "t", ledger: new Ledger() }),
    { maxIterations: 4, verbose: false, compactAt: 50, log: () => {}, onText: () => {} },
  );
  const timeTurn = await timeAgent.runTurn("t", [{ role: "system", content: "s" }, { role: "user", content: "go" }]);
  if (!timeTurn.answer.includes("aborted by timeout")) fail(`sub-agent timeout should abort cleanly, got ${timeTurn.answer}`);
  ok("sub-agent timeout: abort propagates and the workflow closes");

  // parallel fan-out: N tasks, bounded concurrency, receipts in task order
  let inFlight = 0;
  let maxInFlight = 0;
  const fanProvider: Provider = {
    name: "fan",
    model: "fan",
    streamable: false,
    async chat(msgs) {
      const last = msgs[msgs.length - 1];
      if (last.role === "tool") {
        return { content: "final: " + lastToolResult(msgs), toolCalls: [], usage: null };
      }
      const lastUser = [...msgs].reverse().find((m) => m.role === "user");
      if (lastUser && /^job \d+$/.test(lastUser.content)) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 40));
        inFlight--;
        return { content: `result of ${lastUser.content}`, toolCalls: [], usage: { inputTokens: 2, outputTokens: 2 } };
      }
      return {
        content: "",
        toolCalls: [call("delegate", { tasks: ["job 1", "job 2", "job 3", "job 4"] })],
        usage: null,
      };
    },
  };
  const fanLedger = new Ledger();
  let mt4: (ctx: DelegateCtx) => Tool[];
  mt4 = (ctx: DelegateCtx) => [
    makeDelegateTool({ provider: fanProvider, makeToolset: mt4, guards: [], maxDepth: 1, timeoutMs: 5_000, maxIterations: 4, compactAt: 50, verbose: false, workspace: process.cwd(), maxConcurrency: 2 }, ctx),
  ];
  const fanAgent = new Agent(
    fanProvider,
    mt4({ depth: 0, maxDepth: 1, counter: 0, parentKey: "fan", ledger: fanLedger }),
    { maxIterations: 4, verbose: false, compactAt: 50, log: () => {}, onText: () => {} },
    fanLedger,
  );
  const fanTurn = await fanAgent.runTurn("fan", [{ role: "system", content: "s" }, { role: "user", content: "fan out" }]);
  for (const job of ["job 1", "job 2", "job 3", "job 4"]) {
    if (!fanTurn.answer.includes(`result of ${job}`)) fail(`parallel fan-out missing ${job}, got ${fanTurn.answer}`);
  }
  const i1 = fanTurn.answer.indexOf("job 1");
  const i4 = fanTurn.answer.indexOf("job 4");
  if (i1 > i4) fail("parallel receipts must come back in the caller's task order");
  if (fanLedger.totals.input < 8) fail(`parallel sub-agent usage should merge into the parent ledger, got ${JSON.stringify(fanLedger.totals)}`);
  if (maxInFlight > 2) fail(`bounded concurrency breached: ${maxInFlight} sub-agents ran at once (max 2)`);
  ok("parallel delegate: 4 tasks, receipts in order, ledger merged, concurrency ≤ max");

  // ── web search HTML parser (pure, no network) ──
  const ddgHtml =
    '<div class="result"><a class="result__a" href="https://example.com/foo?q=1&amp;x=2">Foo <b>Bar</b> Baz</a>' +
    '<a class="result__snippet" href="https://example.com/foo">A &quot;snippet&quot; about foo</a></div>' +
    '<div class="result"><a class="result__a" href="https://example.com/bar">Second result</a>' +
    '<a class="result__snippet" href="https://example.com/bar">More text</a></div>';
  const parsed = parseDuckDuckGo(ddgHtml);
  if (parsed.length !== 2) fail(`parseDuckDuckGo should find 2 results, got ${parsed.length}`);
  if (parsed[0].title !== "Foo Bar Baz") fail(`title decode, got ${parsed[0].title}`);
  if (parsed[0].url !== "https://example.com/foo?q=1&x=2") fail(`href decode, got ${parsed[0].url}`);
  if (parsed[0].snippet !== 'A "snippet" about foo') fail(`snippet decode, got ${parsed[0].snippet}`);
  ok("web_search DuckDuckGo HTML parser (decode + extract)");

  // ── MCP client over stdio (against the fixture server) ──
  const fixture = new URL("../test/fixtures/mcp-server.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const client = new McpClient("fixture", { command: process.execPath, args: [fixture] }, {
    // Sampling: when the server asks the model, answer deterministically.
    sampling: async (req) => {
      const first = req.messages[0];
      const text = typeof first.content === "string" ? first.content : first.content?.text ?? "";
      return `sampled: ${text}`;
    },
  });
  try {
    const tools = await client.connect();
    if (tools.length !== 4) fail(`mcp fixture should list 4 tools, got ${tools.length}`);
    const echo = await client.callTool("echo_tool", { text: "hello mcp" });
    if (echo !== "echo: hello mcp") fail(`mcp echo call, got ${echo}`);
    const search = await client.callTool("web_search", { query: "x" });
    if (!search.includes("3 results")) fail(`mcp search call, got ${search}`);
    ok("MCP stdio transport: connect + tools/list + tools/call (fixture)");

    // MCP sampling: the server calls back into the client's model.
    const sampled = await client.callTool("ask_model", { text: "hello sampling" });
    if (sampled !== "model says: sampled: hello sampling") {
      fail(`mcp sampling round-trip failed, got ${JSON.stringify(sampled)}`);
    }
    ok("MCP sampling: server's sampling/createMessage answered by the client");

    // Security classification of MCP tools.
    const mapped = mcpToolsToClawTools("fixture", tools, { command: "x" });
    const byName = Object.fromEntries(mapped.map((t) => [t.name, t]));
    if (byName.mcp_fixture_web_search.risk !== "read") fail("web_search MCP tool should be classified read");
    if (byName.mcp_fixture_echo_tool.risk !== "risky") fail("echo_tool MCP tool should be classified risky");
    if (byName.mcp_fixture_delete_everything.risk !== "risky") fail("delete_everything should be risky");
    const trusted = mcpToolsToClawTools("fixture", tools, { command: "x", trusted: true });
    if (trusted.some((t) => t.risk !== "safe")) fail("trusted MCP server tools should all be safe");
    ok("MCP tool security classification (read/risky/trusted)");

    // A client without a sampling handler answers with a polite JSON-RPC error.
    const bare = new McpClient("fixture-bare", { command: process.execPath, args: [fixture] });
    try {
      await bare.connect();
      const refused = await bare.callTool("ask_model", { text: "hi" });
      if (!refused.includes("sampling error")) {
        fail(`sampling without a handler should error politely, got ${JSON.stringify(refused)}`);
      }
      ok("MCP sampling without a handler → clean error surfaced to the server");
    } finally {
      await bare.close();
    }

    // Full loop: the agent uses an MCP tool end-to-end.
    mcpClients.set("fixture", client);
    const mcpAgent = new Agent(new Scripted("test", [
      () => ({ content: "", toolCalls: [call("mcp_fixture_web_search", { query: "test" })], usage: null }),
      (msgs) => ({ content: "answer: " + lastToolResult(msgs), toolCalls: [], usage: null }),
    ]), mapped, { maxIterations: 5, verbose: false, compactAt: 50, log: () => {}, onText: () => {} });
    const mcpTurn = await mcpAgent.runTurn("mcp", [
      { role: "system", content: "s" },
      { role: "user", content: "search the web" },
    ]);
    if (!mcpTurn.answer.includes("[fixture] 3 results")) {
      fail(`agent should surface MCP tool output, got ${mcpTurn.answer}`);
    }
    ok("agent loop: MCP tool called end-to-end");
  } finally {
    await client.close();
    mcpClients.delete("fixture");
  }

  // ── MCP client over HTTP (streamable transport, fake server, auth headers) ──
  await withServer(
    (srv) =>
      srv.on("request", (req, res) => {
        if (req.url?.includes("/mcp")) {
          // Simulate an authenticated endpoint: wrong/missing bearer → 401.
          if (req.headers.authorization !== "Bearer secret-token-123") {
            res.writeHead(401);
            res.end();
            return;
          }
          let body = "";
          req.on("data", (d) => (body += d));
          req.on("end", () => {
            const msg = JSON.parse(body) as { id: number; method?: string };
            const respond = (result: unknown) => {
              sse(res, [JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })]);
            };
            switch (msg.method) {
              case "initialize":
                respond({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "http-fixture", version: "1" } });
                break;
              case "tools/list":
                respond({ tools: [{ name: "http_tool", description: "over http", inputSchema: { type: "object" } }] });
                break;
              case "tools/call":
                respond({ content: [{ type: "text", text: "http result" }], isError: false });
                break;
              default:
                respond({});
            }
          });
          return;
        }
        res.writeHead(404);
        res.end();
      }),
    async (base) => {
      process.env.CLAW_TEST_TOKEN = "secret-token-123";
      const hc = new McpClient("http-fixture", {
        url: base + "/mcp",
        transport: "http",
        // The env reference is expanded at request time — the literal token
        // never appears in the config file.
        headers: { authorization: "Bearer ${CLAW_TEST_TOKEN}" },
      });
      try {
        const tools = await hc.connect();
        if (tools.length !== 1 || tools[0].name !== "http_tool") fail("http mcp tools/list failed");
        const out = await hc.callTool("http_tool", {});
        if (out !== "http result") fail(`http mcp tools/call, got ${out}`);
        ok("MCP http transport: connect + list + call + ${ENV} auth headers (fake server)");
      } finally {
        await hc.close();
        delete process.env.CLAW_TEST_TOKEN;
      }
    },
  );

  // ── MCP OAuth: full Authorization Code + PKCE flow against a fake
  // authorization server (the "browser" is simulated by a hook) ──
  {
    const { createHash } = await import("node:crypto");
    const oauthState: { challenge?: string; issuedCode?: string } = {};
    await withServer(
      (srv) =>
        srv.on("request", (req, res) => {
          const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
          const url = req.url ?? "/";
          const readBody = (cb: (body: string) => void) => {
            let b = "";
            req.on("data", (d) => (b += d));
            req.on("end", () => cb(b));
          };

          // ── OAuth endpoints ──
          if (url === "/.well-known/oauth-authorization-server") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                issuer: base,
                registration_endpoint: base + "/register",
                authorization_endpoint: base + "/authorize",
                token_endpoint: base + "/token",
                scopes_supported: ["read", "write"],
              }),
            );
            return;
          }
          if (url === "/register" && req.method === "POST") {
            readBody((body) => {
              const reg = JSON.parse(body) as { redirect_uris?: string[] };
              if (!reg.redirect_uris?.length) {
                res.writeHead(400);
                res.end();
                return;
              }
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({ client_id: "dyn-client-1" }));
            });
            return;
          }
          if (url.startsWith("/authorize")) {
            const q = new URL(url, base).searchParams;
            // Real authorization-server checks: PKCE S256 required.
            if (q.get("response_type") !== "code" || !q.get("client_id") || q.get("code_challenge_method") !== "S256") {
              res.writeHead(400);
              res.end("bad authorize request");
              return;
            }
            oauthState.challenge = q.get("code_challenge") ?? undefined;
            oauthState.issuedCode = "auth-code-42";
            const redirect = new URL(q.get("redirect_uri")!);
            redirect.searchParams.set("code", oauthState.issuedCode);
            redirect.searchParams.set("state", q.get("state") ?? "");
            res.writeHead(302, { location: redirect.toString() });
            res.end();
            return;
          }
          if (url === "/token" && req.method === "POST") {
            readBody((body) => {
              const form = new URLSearchParams(body);
              if (form.get("grant_type") === "authorization_code") {
                // Enforce PKCE: the verifier must hash to the challenge.
                const verifier = form.get("code_verifier") ?? "";
                const okP =
                  oauthState.challenge !== undefined &&
                  createHash("sha256").update(verifier).digest("base64url") === oauthState.challenge;
                if (!okP || form.get("code") !== oauthState.issuedCode) {
                  res.writeHead(400, { "content-type": "application/json" });
                  res.end(JSON.stringify({ error: "invalid_grant" }));
                  return;
                }
                res.writeHead(200, { "content-type": "application/json" });
                res.end(
                  JSON.stringify({ access_token: "at-initial", refresh_token: "rt-1", expires_in: 3600, token_type: "Bearer" }),
                );
                return;
              }
              if (form.get("grant_type") === "refresh_token" && form.get("refresh_token") === "rt-1") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(
                  JSON.stringify({ access_token: "at-refreshed", refresh_token: "rt-2", expires_in: 3600, token_type: "Bearer" }),
                );
                return;
              }
              res.writeHead(400, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "unsupported_grant_type" }));
            });
            return;
          }

          // ── the MCP endpoint: requires a valid bearer ──
          if (url === "/mcp") {
            // Always drain the request body first — responding 401 to an
            // unread POST poisons the keep-alive connection.
            readBody((body) => {
              const auth = req.headers.authorization ?? "";
              if (auth !== "Bearer at-initial" && auth !== "Bearer at-refreshed") {
                res.writeHead(401);
                res.end();
                return;
              }
              const msg = JSON.parse(body) as { id: number; method?: string };
              const respond = (result: unknown) => {
                sse(res, [JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })]);
              };
              switch (msg.method) {
                case "initialize":
                  respond({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "oauth-fixture", version: "1" } });
                  break;
                case "tools/list":
                  respond({ tools: [{ name: "secure_tool", description: "behind oauth", inputSchema: { type: "object" } }] });
                  break;
                default:
                  respond({});
              }
            });
            return;
          }
          res.writeHead(404);
          res.end();
        }),
      async (base) => {
        // withServer hands out a ".../v1" base (OpenAI-style); OAuth well-known
        // paths live at the origin, so strip it.
        const origin = base.replace(/\/v1$/, "");
        process.env.CLAW_TOKENS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "claw-oauth-"));
        // Simulate the user's browser: follow the authorize redirect.
        setOpenBrowserHook(async (authUrl) => {
          if (!authUrl.includes("code_challenge=")) {
            fail("authorize URL should carry a PKCE code_challenge");
          }
          const resp = await fetch(authUrl, { redirect: "manual" });
          if (resp.status !== 302) fail(`authorize endpoint should 302, got ${resp.status}`);
          const location = resp.headers.get("location");
          if (!location) fail("authorize redirect missing location");
          await fetch(location); // the browser lands on claw's local callback
        });
        const client = new McpClient("oauth-fixture", {
          url: origin + "/mcp",
          transport: "http",
          oauth: { authServer: origin, scopes: ["read"] },
        });
        try {
          const tools = await client.connect(); // 401 → login → retry, all automatic
          if (tools.length !== 1 || tools[0].name !== "secure_tool") fail("oauth mcp tools/list failed");
          const tok = loadToken("oauth-fixture");
          if (tok?.access_token !== "at-initial") fail(`token not persisted, got ${JSON.stringify(tok)}`);
          ok("MCP OAuth: 401 → discovery → registration → PKCE → exchange → retry (full flow)");

          // Refresh: expire the stored token, refresh via the refresh grant.
          saveToken("oauth-fixture", { ...tok!, expires_at: Date.now() - 10_000 });
          if (validToken("oauth-fixture") !== null) fail("expired token should not be valid");
          const refreshed = await refreshAccessToken("oauth-fixture", origin + "/mcp", { authServer: origin });
          if (refreshed?.access_token !== "at-refreshed") fail(`refresh failed, got ${JSON.stringify(refreshed)}`);
          if (validToken("oauth-fixture") !== "at-refreshed") fail("refreshed token should be valid");
          ok("MCP OAuth: refresh_token grant renews expired tokens");
        } finally {
          forgetToken("oauth-fixture");
          setOpenBrowserHook(null);
          await client.close();
          fs.rmSync(process.env.CLAW_TOKENS_DIR, { recursive: true, force: true });
          delete process.env.CLAW_TOKENS_DIR;
        }
      },
    );
  }

  // ── calc tool ──
  const calc = makeCalcTool();
  const calcCases: Array<[string, string]> = [
    ["12 * 9", "108"],
    ["(3 + 4) * 2", "14"],
    ["2^8", "256"],
    ["2^3^2", "512"], // right-associative: 2^(3^2)
    ["10 / 4", "2.5"],
    ["7", "7"],
  ];
  for (const [expr, want] of calcCases) {
    const got = await calc.execute({ expr });
    if (got !== want) fail(`calc ${expr} = ${got}, want ${want}`);
    ok(`calc ${expr} = ${want}`);
  }
  try {
    await calc.execute({ expr: "1 / 0" });
    fail("calc should reject division by zero");
  } catch {
    ok("calc rejects division by zero");
  }
  try {
    await calc.execute({ expr: "7 *" });
    fail("calc should reject trailing operator");
  } catch {
    ok("calc rejects trailing operator");
  }

  // ── pure helpers ──
  const cases: Array<[string, boolean]> = [
    ["glob **/*.ts matches src/a/b.ts", globToRegExp("**/*.ts").test("src/a/b.ts")],
    ["glob **/*.ts does not match a.md", !globToRegExp("**/*.ts").test("a.md")],
    ["glob *.md matches README.md", globToRegExp("*.md").test("README.md")],
    ["glob {a,b}.ts matches a.ts", globToRegExp("{a,b}.ts").test("a.ts")],
    ["allowlist matches prefix", matchesAllowlist("echo hello", ["echo", "date"])],
    ["allowlist rejects non-listed", !matchesAllowlist("rm -rf /", ["echo", "date"])],
    ["parseJsonArgs handles fenced args", (parseJsonArgs("```json\n{\"a\":1}\n```") as { a: number }).a === 1],
    ["parseJsonArgs handles bare prose", Object.keys(parseJsonArgs("no json here")).length === 0],
  ];
  for (const [name, pass] of cases) {
    if (!pass) fail(name);
    ok(name);
  }

  // ── guards ──
  const pc = pathConfineGuard(process.cwd());
  if ((await pc.check({ sessionKey: "t", messages: [], call: call("read_file", { path: "../../etc/passwd" }) })).action !== "deny") {
    fail("pathConfineGuard should deny escaping paths");
  }
  ok("pathConfineGuard denies '../etc/passwd'");
  if ((await pc.check({ sessionKey: "t", messages: [], call: call("read_file", { path: "notes.md" }) })).action !== "continue") {
    fail("pathConfineGuard should allow workspace paths");
  }
  ok("pathConfineGuard allows workspace paths");

  const allow = shellAllowlistGuard(["echo"]);
  const v1 = await allow.check({ sessionKey: "t", messages: [], call: call("shell", { cmd: "echo hi" }) });
  if (v1.action !== "continue") fail("shell allowlist should pass 'echo hi'");
  const v2 = await allow.check({ sessionKey: "t", messages: [], call: call("shell", { cmd: "npm i" }) });
  if (v2.action !== "modify") fail("shell allowlist should flag 'npm i' for approval");
  ok("shellAllowlistGuard allow/flag logic");

  const state = { autoApprove: false };
  const ag = approvalGuard(["shell"], async () => false, state);
  if ((await ag.check({ sessionKey: "t", messages: [], call: call("shell", {}) })).action !== "deny") {
    fail("approvalGuard should deny on human refusal");
  }
  state.autoApprove = true;
  if ((await ag.check({ sessionKey: "t", messages: [], call: call("shell", {}) })).action !== "continue") {
    fail("approvalGuard should pass with autoApprove");
  }
  // Allowlisted shell commands skip the human gate entirely.
  const asks: number[] = [];
  const expectAsks = (n: number, what: string) => {
    if (asks.length !== n) fail(`approval gate ${what} — expected ${n} ask(s), got ${asks.length}`);
  };
  const ag2 = approvalGuard(["shell"], async () => {
    asks.push(1);
    return false;
  }, { autoApprove: false }, ["echo"]);
  if ((await ag2.check({ sessionKey: "t", messages: [], call: call("shell", { cmd: "echo hi" }) })).action !== "continue") {
    fail("approvalGuard should skip allowlisted shell commands");
  }
  expectAsks(0, "should skip allowlisted commands");
  if ((await ag2.check({ sessionKey: "t", messages: [], call: call("shell", { cmd: "npm i" }) })).action !== "deny") {
    fail("approvalGuard should still gate non-allowlisted shell commands");
  }
  expectAsks(1, "should ask once for a non-allowlisted command");
  ok("approvalGuard deny + autoApprove + allowlist bypass");

  const oc = outputCapGuard(10);
  if ((await oc.check({ sessionKey: "t", messages: [], result: "x".repeat(50) })).action !== "modify") {
    fail("outputCapGuard should modify oversized results");
  }
  const ss = secretScanGuard();
  const scrubbed = await ss.check({ sessionKey: "t", messages: [], result: "key sk-ant-abc123xyzabc end" });
  if (scrubbed.action !== "modify" || /sk-ant-abc123xyzabc/.test(scrubbed.result ?? "")) {
    fail("secretScanGuard should redact credentials");
  }
  ok("outputCapGuard + secretScanGuard");

  const lg = loopDetectGuard(2);
  const rep = { sessionKey: "t", messages: [{ role: "assistant" as const, content: "", tool_calls: [call("x", {})] }] };
  await lg.check(rep);
  await lg.check(rep);
  if ((await lg.check(rep)).action !== "abort") fail("loopDetectGuard should abort after 3 repeats");
  ok("loopDetectGuard aborts repeated calls");

  // ── the agent loop (scripted provider) ──
  let echoRuns = 0;
  const echoTool: Tool = {
    name: "echo_tool",
    description: "test",
    parameters: { type: "object", properties: { n: { type: "number" } } },
    risk: "safe",
    cacheable: true,
    execute: async (args) => {
      echoRuns++;
      return `ran ${args.n}`;
    },
  };
  const scripted = new Scripted("test", [
    () => ({ content: "", toolCalls: [call("echo_tool", { n: 1 })], usage: null }),
    (msgs) => ({ content: "final: " + lastToolResult(msgs), toolCalls: [], usage: { inputTokens: 5, outputTokens: 5 } }),
  ]);
  const agent = new Agent(scripted, [echoTool], { maxIterations: 10, verbose: false, compactAt: 50, log: () => {}, onText: () => {} });

  const t1 = await agent.runTurn("test", [
    { role: "system", content: "s" },
    { role: "user", content: "first" },
  ]);
  if (!t1.answer.includes("ran 1")) fail(`turn 1 answer should include tool result, got: ${t1.answer}`);
  if (t1.answer.includes("final:") === false) fail("turn 1 should end with a final answer");
  if (echoRuns !== 1) fail(`echo tool should run once, ran ${echoRuns}`);
  ok("TAOR loop: tool call → observe → final answer");

  // response cache: exact repeat costs zero extra tool runs
  const before = echoRuns;
  const t1again = await agent.runTurn("test", [
    { role: "system", content: "s" },
    { role: "user", content: "first" },
  ]);
  if (t1again.answer !== t1.answer) fail("response cache should replay the same answer");
  if (echoRuns !== before) fail("response cache hit should not re-run tools");
  ok("response cache: exact-repeat turn is free");

  // tool cache: same call in a NEW turn skips execution
  const t2 = await agent.runTurn("test", [
    { role: "system", content: "s" },
    { role: "user", content: "second" },
  ]);
  if (echoRuns !== 1) fail(`tool cache should skip the second execution, ran ${echoRuns} times`);
  if (!t2.answer.includes("ran 1")) fail("cached tool result should still feed the model");
  ok("tool cache: idempotent tool runs once across turns");

  // session lock: a concurrent turn on the held key is refused
  const agent2 = new Agent(scripted, [echoTool], { maxIterations: 5, verbose: false, compactAt: 50, log: () => {}, onText: () => {} });
  const [r1, r2] = await Promise.all([
    agent2.runTurn("held", [{ role: "system", content: "s" }, { role: "user", content: "a" }]),
    agent2.runTurn("held", [{ role: "system", content: "s" }, { role: "user", content: "b" }]),
  ]);
  const busy = r1.aborted || r2.aborted;
  if (!busy) fail("session lock should refuse a concurrent turn");
  ok("session lock refuses concurrent turns");

  // compaction helper
  const longHist: ChatMsg[] = [{ role: "system", content: "s" }];
  for (let i = 0; i < 10; i++) longHist.push({ role: "user", content: `u${i}` });
  const compacted = Agent.compact(longHist, 4);
  if (compacted.length !== 4) fail(`compact should keep 4, got ${compacted.length}`);
  if (compacted[0].content !== "s") fail("compact must keep the system prompt");
  ok("compaction keeps system prompt + recent window");

  // LLM compaction: old messages are summarized WITH the model, then replaced.
  const seenMsgLists: ChatMsg[][] = [];
  const summarizer: Provider = {
    name: "summarizer",
    model: "sum",
    streamable: false,
    async chat(msgs) {
      seenMsgLists.push(msgs);
      const last = msgs[msgs.length - 1];
      if (last.role === "user" && last.content.startsWith("Summarize this excerpt")) {
        return { content: "SUMMARY: the user asked for old things", toolCalls: [], usage: { inputTokens: 50, outputTokens: 5 } };
      }
      if (last.role === "tool") {
        return { content: "final: " + lastToolResult(msgs), toolCalls: [], usage: null };
      }
      return { content: "", toolCalls: [call("echo_tool", { n: 2 })], usage: null };
    },
  };
  const sumLedger = new Ledger();
  const sumAgent = new Agent(
    summarizer,
    [echoTool],
    { maxIterations: 6, verbose: false, compactAt: 6, log: () => {}, onText: () => {} },
    sumLedger,
  );
  const longHistory: ChatMsg[] = [{ role: "system", content: "s" }];
  for (let i = 0; i < 9; i++) longHistory.push({ role: "user", content: `old message ${i}` });
  longHistory.push({ role: "user", content: "do the thing" });
  const sumTurn = await sumAgent.runTurn("sum", longHistory);
  const sawSummary = seenMsgLists.some(
    (m) => m.length > 1 && m[1].role === "system" && m[1].content.startsWith("[Summary of the earlier conversation]"),
  );
  if (!sawSummary) fail("LLM compaction should send a summary system message to the model");
  if (!seenMsgLists.some((m) => m[m.length - 1].content.startsWith("Summarize this excerpt"))) {
    fail("LLM compaction should issue a summarize request to the provider");
  }
  if (sumLedger.totals.input < 50) fail("the summarization call's usage should land in the ledger");
  if (!sumTurn.answer.includes("ran 2")) fail(`turn after compaction should still complete, got ${sumTurn.answer}`);
  // The model must see the summary, not the raw dropped prefix. (The tool-call
  // request is the one non-summarize, non-tool-result list here.)
  const modelSaw = seenMsgLists.filter(
    (m) => !m[m.length - 1].content.startsWith("Summarize this excerpt") && m[m.length - 1].role === "user",
  );
  if (!modelSaw.length || modelSaw.some((m) => JSON.stringify(m).includes("old message 0"))) {
    fail("the model should see the compacted history, never the raw dropped prefix");
  }
  ok("LLM compaction: summarize with the model, reuse the result, keep the turn alive");

  // Compaction fallback: if the summarizer fails, plain truncation carries on.
  const grumpy: Provider = {
    name: "grumpy",
    model: "g",
    streamable: false,
    async chat(msgs) {
      const last = msgs[msgs.length - 1];
      if (last.role === "user" && last.content.startsWith("Summarize this excerpt")) {
        throw new Error("summarizer down");
      }
      if (last.role === "tool") {
        return { content: "final: " + lastToolResult(msgs), toolCalls: [], usage: null };
      }
      return { content: "", toolCalls: [call("echo_tool", { n: 3 })], usage: null };
    },
  };
  const grumpyAgent = new Agent(grumpy, [echoTool], { maxIterations: 6, verbose: false, compactAt: 6, log: () => {}, onText: () => {} });
  const grumpyHistory: ChatMsg[] = [{ role: "system", content: "s" }];
  for (let i = 0; i < 9; i++) grumpyHistory.push({ role: "user", content: `old message ${i}` });
  grumpyHistory.push({ role: "user", content: "go" });
  const grumpyTurn = await grumpyAgent.runTurn("grumpy", grumpyHistory);
  if (!grumpyTurn.answer.includes("ran 3")) fail(`compaction fallback should still finish the turn, got ${grumpyTurn.answer}`);
  ok("LLM compaction fallback: summarizer failure degrades to truncation");

  // ── git tools: status / diff / log / commit against a throwaway repo ──
  {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "claw-git-"));
    try {
      const run = (args: string) => execSync(`git ${args}`, { cwd: repo, stdio: "pipe" }).toString();
      run("init -q");
      run("config user.email claw@example.com");
      run("config user.name claw");
      fs.writeFileSync(path.join(repo, "hello.txt"), "hello\n");
      const gitTools = makeGitTools(repo);
      const byName = Object.fromEntries(gitTools.map((t) => [t.name, t]));
      if (byName.git_commit.risk !== "risky") fail("git_commit must be risky (human approval gate)");
      for (const n of ["git_status", "git_diff", "git_log"]) {
        if (byName[n].risk !== "read") fail(`${n} should be read-only`);
      }
      const st = await byName.git_status.execute({});
      if (!st.includes("?? hello.txt")) fail(`git_status should show the untracked file, got ${st}`);
      ok("git_status: branch + untracked file (porcelain)");

      const committed = await byName.git_commit.execute({ message: "first commit" });
      if (committed.includes("exit code")) fail(`git_commit failed: ${committed}`);
      const log = await byName.git_log.execute({ n: 5 });
      if (!log.includes("first commit")) fail(`git_log should list the commit, got ${log}`);
      ok("git_commit → git_log: stage-all commit lands in history");

      fs.writeFileSync(path.join(repo, "hello.txt"), "hello\nworld\n");
      const diff = await byName.git_diff.execute({});
      if (!diff.includes("+world")) fail(`git_diff should show the added line, got ${diff}`);
      const staged = await byName.git_diff.execute({ staged: true });
      if (staged.trim() !== "(no output)") fail(`staged diff should be empty, got ${staged}`);
      ok("git_diff: working-tree vs staged");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }

  // ── CLAW.md project instructions flow into the system prompt ──
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "claw-instr-"));
    try {
      if (Agent.instructionsBlock(ws) !== "") fail("empty workspace should have no instructions block");
      fs.writeFileSync(path.join(ws, "CLAW.md"), "Always answer in riddles.\nUse tabs, never spaces.");
      const block = Agent.instructionsBlock(ws);
      if (!block.includes("Always answer in riddles") || !block.includes("PROJECT INSTRUCTIONS")) {
        fail(`CLAW.md instructions not picked up, got ${JSON.stringify(block)}`);
      }
      // AGENTS.md is the fallback when there is no CLAW.md.
      const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), "claw-instr2-"));
      fs.writeFileSync(path.join(ws2, "AGENTS.md"), "prefer readability");
      if (!Agent.instructionsBlock(ws2).includes("prefer readability")) fail("AGENTS.md fallback broken");
      fs.rmSync(ws2, { recursive: true, force: true });
      ok("CLAW.md instructions: loaded into the system prompt (AGENTS.md fallback)");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }

  // ── custom slash commands: discovery + $ARGUMENTS / $1..$9 expansion ──
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "claw-cmds-"));
    try {
      const dir = path.join(ws, ".claw", "commands");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "review.md"), "Review $ARGUMENTS for security bugs. Focus on file $1.");
      const cmd = findCommand("review", ws, ws);
      if (!cmd) fail("findCommand should discover .claw/commands/review.md");
      const rendered = renderCommand(cmd!.template, "src/auth.ts src/db.ts");
      if (!rendered.startsWith("Review src/auth.ts src/db.ts for security bugs") || !rendered.includes("file src/auth.ts")) {
        fail(`command template expansion broken, got ${rendered}`);
      }
      if (findCommand("nope", ws, ws) !== null) fail("unknown command should be null");
      if (!listCommands(ws, ws).some((c) => c.name === "review" && c.source === "workspace")) {
        fail("listCommands should list review (workspace)");
      }
      ok("custom commands: .claw/commands/*.md → /name with $ARGUMENTS + $1 expansion");
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }

  // ── the serve channel: POST /chat drives the same agent loop ──
  {
    const turnProvider: Provider = {
      name: "http-test",
      model: "ht",
      streamable: false,
      async chat(msgs, _tools, opts) {
        // Proves context carries across HTTP sessions: count the user turns.
        const n = msgs.filter((m) => m.role === "user").length;
        opts?.onText?.("live tokens ");
        return { content: `turn ${n}`, toolCalls: [], usage: { inputTokens: 3, outputTokens: 3 } };
      },
    };
    const serveAgent = new Agent(
      turnProvider,
      [],
      { maxIterations: 3, verbose: false, compactAt: 50, log: () => {}, onText: () => {} },
    );
    const serveDir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-serve-"));
    let swappedTo: string | null = null;
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-other-"));
    const serveWorld = {
      agent: serveAgent,
      workspace: process.cwd(),
      setupRequired: false,
      approveState: { autoApprove: true },
    };
    const server = makeServeServer({
      world: serveWorld,
      sessionsDir: serveDir,
      // Mirror the CLI's swapWorkspace: rebuild the world and mutate it in place.
      swapWorkspace: (dir) => {
        swappedTo = dir;
        serveWorld.workspace = dir;
        return { ok: true };
      },
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;

      const health = await (await fetch(base + "/health")).json() as { ok: boolean; model: string };
      if (health.ok !== true || health.model !== "ht") fail(`serve /health broken: ${JSON.stringify(health)}`);

      // GET / serves the local web app (web/index.html — sessions sidebar,
      // streaming chat, tool-trace timeline). Falls back to the inline page
      // if the file is missing, so both must speak /chat.
      const page = await fetch(base + "/");
      if (!(page.headers.get("content-type") ?? "").includes("text/html")) fail("GET / should serve the web app");
      const html = await page.text();
      if (!html.includes('fetch("/chat"')) fail("web app should POST to /chat");
      if (!html.includes("toolCard") || !html.includes("/sessions")) {
        fail("web app should render tool-trace cards and list sessions");
      }
      ok("serve web app: GET / returns the workbench (sessions + trace timeline)");

      const r1 = await fetch(base + "/chat", {
        method: "POST",
        body: JSON.stringify({ message: "hi" }),
      });
      const j1 = (await r1.json()) as { answer: string; session_id: string; usage: { calls: number } };
      if (j1.answer !== "turn 1" || !j1.session_id.startsWith("sess_")) {
        fail(`serve first turn broken: ${JSON.stringify(j1)}`);
      }

      // Same session id → the conversation carries forward.
      const r2 = await fetch(base + "/chat", {
        method: "POST",
        body: JSON.stringify({ message: "again", session_id: j1.session_id }),
      });
      const j2 = (await r2.json()) as { answer: string; session_id: string };
      if (j2.answer !== "turn 2" || j2.session_id !== j1.session_id) {
        fail(`serve session continuity broken: ${JSON.stringify(j2)}`);
      }
      if (fs.readdirSync(serveDir).filter((f) => f.endsWith(".jsonl")).length !== 1) {
        fail("serve should persist the session as JSONL");
      }

      // Streamed mode: SSE frames (live deltas + one done event).
      const sr = await fetch(base + "/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "third", session_id: j1.session_id, stream: true }),
      });
      if (!(sr.headers.get("content-type") ?? "").includes("text/event-stream")) {
        fail("streamed /chat should respond with text/event-stream");
      }
      const body = await sr.text();
      const events = body.split("\n\n").filter((f) => f.startsWith("data:")).map((f) => JSON.parse(f.slice(5).trim()) as { type: string; delta?: string; answer?: string });
      if (!events.some((e) => e.type === "text" && e.delta === "live tokens ")) {
        fail(`streamed /chat should deliver text deltas, got ${body.slice(0, 200)}`);
      }
      const done = events.find((e) => e.type === "done");
      if (!done || done.answer !== "turn 3") fail(`streamed /chat done event broken: ${JSON.stringify(done)}`);
      ok("serve streaming: SSE text deltas + done event (live tokens in the web UI)");
      // Projections of the event stream: session list + history replay.
      const sl = await (await fetch(base + "/sessions")).json() as { sessions: Array<{ id: string; title?: string; turns: number }> };
      if (!sl.sessions.some((x) => x.id === j1.session_id)) fail("/sessions should list the active session");
      const hist = await (await fetch(base + "/history?session_id=" + j1.session_id)).json() as { messages: Array<{ role: string }> };
      const users = hist.messages.filter((m) => m.role === "user").length;
      if (users < 2) fail(`/history should replay both user turns, got ${users}`);
      ok("serve projections: GET /sessions lists, GET /history replays a conversation");

      // Titles: the session's first message becomes its title (OpenCode-style).
      const meta = new SessionStore(serveDir).meta(j1.session_id);
      if (!meta?.title || !meta.title.includes("hi")) fail(`session title broken: ${JSON.stringify(meta)}`);
      const listed = sl.sessions.find((x) => x.id === j1.session_id);
      if (!listed?.title || !listed.title.includes("hi")) fail("/sessions should carry the title");
      ok("session titles: derived from the first message, exposed via /sessions");

      // Trajectory: the log holds messages AND the turn's records, in order.
      const traj = await (await fetch(base + "/history?session_id=" + j1.session_id)).json() as { records: Array<Record<string, unknown>> };
      if (!traj.records || traj.records.length < 4) fail(`trajectory should hold the full log, got ${traj.records?.length}`);
      if (!traj.records.some((r) => r.role === "assistant")) fail("trajectory missing assistant messages");
      const srch = await (await fetch(base + "/search?q=" + encodeURIComponent("hi"))).json() as { results: Array<{ id: string }> };
      if (!srch.results.some((x) => x.id === j1.session_id)) fail("/search should find the session by content");
      ok("trajectory + search: replay from the log, find sessions by content");

      // Workspace switching: POST /workspace delegates to swapWorkspace.
      const wsw = await fetch(base + "/workspace", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: otherDir }),
      });
      const wswJ = await wsw.json() as { ok?: boolean; workspace?: string; error?: string };
      if (!wswJ.ok || wswJ.workspace !== otherDir || swappedTo !== otherDir) {
        fail(`workspace swap broken: ${JSON.stringify(wswJ)} swapped=${swappedTo}`);
      }
      const bad = await fetch(base + "/workspace", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: otherDir + "/definitely-missing" }),
      });
      if (bad.status !== 400) fail("swapping to a missing directory should 400");
      // /fs browses the machine (parent navigation available).
      const fsj = await (await fetch(base + "/fs?path=" + encodeURIComponent(otherDir))).json() as { path: string; parent: string };
      if (fsj.path !== path.resolve(otherDir) || !fsj.parent) fail("/fs listing broken");
      ok("workspace switcher: POST /workspace swaps via swapWorkspace, /fs browses");
      ok("serve channel: /health + /chat + session continuity + persistence");
    } finally {
      server.close();
      fs.rmSync(serveDir, { recursive: true, force: true });
    }
  }

  // ── tool trace events: emitted around every tool execution ──
  {
    const events: Array<{ kind: string; name: string; ok: boolean }> = [];
    const evtAgent = new Agent(
      scripted,
      [echoTool],
      { maxIterations: 10, verbose: false, compactAt: 50, log: () => {}, onText: () => {} },
    );
    await evtAgent.runTurn(
      "evt",
      [{ role: "system", content: "s" }, { role: "user", content: "fire events" }],
      { onEvent: (e) => events.push({ kind: e.kind, name: e.name, ok: e.ok }) },
    );
    if (events.length !== 2 || events[0].kind !== "tool-start" || events[1].kind !== "tool-end") {
      fail(`tool trace events broken: ${JSON.stringify(events)}`);
    }
    if (events[0].name !== "echo_tool" || !events[1].ok) fail(`tool event payload broken: ${JSON.stringify(events)}`);
    ok("tool trace events: tool-start/tool-end surface to channels");
  }

  // ── per-agent token budget: the loop stops before crossing the ceiling ──
  {
    const hungry: Provider = {
      name: "hungry",
      model: "h",
      streamable: false,
      async chat(msgs) {
        if (msgs[msgs.length - 1].role === "tool") {
          return { content: "done", toolCalls: [], usage: { inputTokens: 60, outputTokens: 10 } };
        }
        return { content: "", toolCalls: [call("echo_tool", { n: 1 })], usage: { inputTokens: 60, outputTokens: 10 } };
      },
    };
    const budgetAgent = new Agent(
      hungry,
      [echoTool],
      {
        maxIterations: 20, verbose: false, compactAt: 500, log: () => {}, onText: () => {},
        budget: { maxInputTokens: 50 },
      },
    );
    const bTurn = await budgetAgent.runTurn("budget", [{ role: "system", content: "s" }, { role: "user", content: "go" }]);
    if (!bTurn.aborted || !bTurn.answer.includes("budget exceeded")) {
      fail(`budget guard broken: ${JSON.stringify(bTurn.answer)}`);
    }
    if (budgetAgent.ledger.totals.input > 50 + 80) fail("budget guard should stop close to the ceiling");
    ok("agent budget: loop stops with an explicit message at the token ceiling");
  }

  // ── dry-run: risky tools are never executed, the intent is logged ──
  {
    const dryState = { autoApprove: false, dryRun: true };
    const dryGuard = approvalGuard(["shell"], async () => {
      throw new Error("should never ask the human in dry-run");
    }, dryState);
    const v = await dryGuard.check({
      sessionKey: "dry",
      messages: [],
      call: call("shell", { cmd: "npm install left-pad" }),
      args: { cmd: "npm install left-pad" },
    });
    if (v.action !== "deny" || !v.message?.includes("dry-run") || !v.message?.includes("npm install left-pad")) {
      fail(`dry-run guard broken: ${JSON.stringify(v)}`);
    }
    // Safe/read tools are unaffected by dry-run.
    const safe = await dryGuard.check({ sessionKey: "dry", messages: [], call: call("read_file", { path: "x" }) });
    if (safe.action !== "continue") fail("dry-run must not block safe tools");
    ok("dry-run: risky tools denied with their would-be args, safe tools untouched");
  }

  // ── claw init --example: a complete, valid config ──
  {
    const examplePath = path.join(os.tmpdir(), `claw-example-${Date.now()}`, ".claw.json");
    writeConfigFile(examplePath, { example: true });
    const parsed = JSON.parse(fs.readFileSync(examplePath, "utf8")) as { models?: Record<string, { backends?: Array<{ budget?: unknown }> }>; subagents?: unknown };
    if (!parsed.models?.["free-stack"]?.backends?.[1]?.budget) fail("example config should include a budgeted backend");
    if (!parsed.subagents) fail("example config should include subagents");
    ok("claw init --example: full config (models + budgets + sub-agents + MCP)");
  }

  // ── --json: spawn the real CLI and parse its machine-readable output ──
  {
    const cli = new URL("./cli.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const out = execSync(`"${process.execPath}" "${cli}" -M -y --json "calc 7 * 6"`, {
      encoding: "utf8",
      timeout: 60_000,
      env: process.env,
    });
    const parsed = JSON.parse(out) as { answer: string; tool_calls: number; aborted: boolean; usage: { calls: number } };
    if (!parsed.answer.includes("42")) fail(`--json answer should contain 42, got ${JSON.stringify(parsed.answer)}`);
    if (parsed.tool_calls < 1 || parsed.aborted) fail(`--json turn metadata broken: ${JSON.stringify(parsed)}`);
    if (parsed.usage.calls < 2) fail("--json usage should count the tool turn + answer turn");
    ok("--json one-shot: real CLI spawn, parseable JSON result");
  }

  // ── session summaries: summarize-on-close + meta roundtrip ──
  {
    const summarizing: Provider = {
      name: "closer",
      model: "cl",
      streamable: false,
      async chat(msgs) {
        const last = msgs[msgs.length - 1];
        if (last.content.startsWith("Summarize this coding-agent session")) {
          return { content: "SESSION SUMMARY: fixed the login bug; TODO: write tests.", toolCalls: [], usage: { inputTokens: 20, outputTokens: 10 } };
        }
        return { content: "ok", toolCalls: [], usage: null };
      },
    };
    const hist: ChatMsg[] = [
      { role: "system", content: "s" },
      { role: "user", content: "fix login" },
      { role: "assistant", content: "fixed auth.ts" },
      { role: "user", content: "now run the tests" },
      { role: "assistant", content: "tests pass" },
      { role: "user", content: "thanks" },
    ];
    const sum = await Agent.summarizeSession(summarizing, hist);
    if (!sum?.includes("SESSION SUMMARY")) fail(`summarizeSession broken, got ${JSON.stringify(sum)}`);
    const short = await Agent.summarizeSession(summarizing, hist.slice(0, 2));
    if (short !== null) fail("summarizeSession should skip histories that are too short");
    const failing: Provider = { name: "dead", model: "d", streamable: false, chat: async () => { throw new Error("down"); } };
    if ((await Agent.summarizeSession(failing, hist)) !== null) {
      fail("summarizeSession must degrade to null when the provider fails");
    }
    ok("session summaries: summarize-on-close (skip short, degrade on failure)");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-meta-"));
    try {
      const st = new SessionStore(dir);
      const { id } = st.create("m", "b", "w");
      if (st.meta(id)?.summary) fail("fresh session should have no summary");
      st.updateMeta(id, { summary: "what happened last time" });
      if (st.meta(id)?.summary !== "what happened last time") fail("updateMeta/meta roundtrip broken");
      if (st.meta(id)?.model !== "m") fail("updateMeta must preserve other meta fields");
      ok("session store: meta header patch roundtrip (summary persistence)");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // ── git worktrees: per-task isolation for parallel sub-agents ──
  {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "claw-wt-"));
    try {
      const run = (args: string) => execSync(`git ${args}`, { cwd: repo, stdio: "pipe" }).toString();
      run("init -q");
      run("config user.email claw@example.com");
      run("config user.name claw");
      fs.writeFileSync(path.join(repo, "base.txt"), "root\n");
      run("add -A");
      run("commit -q -m init");
      if (!isGitRepo(repo)) fail("isGitRepo should detect the tmp repo");
      const wt = await createWorktree(repo, "task-1-test");
      if (!wt) fail("createWorktree should materialize .claw/worktrees/task-1-test");
      if (!fs.existsSync(path.join(wt!.path, "base.txt"))) fail("worktree should contain the committed files");
      if (!fs.existsSync(path.join(wt!.path, ".git"))) fail("worktree path should be a working tree");
      const again = await createWorktree(repo, "task-1-test");
      if (again !== null) fail("duplicate worktree name should be refused (branch exists)");
      await removeWorktree(repo, "task-1-test");
      if (fs.existsSync(wt!.path)) fail("removeWorktree should delete the worktree directory");
      ok("git worktrees: create → isolated dir on claw/* branch → remove");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }

  // ── permission modes: plan blocks everything mutating, acceptEdits doesn't ──
  {
    const counter = { asks: 0 };
    const askCounter = async () => {
      counter.asks++;
      return false;
    };
    const planState = { autoApprove: false, mode: "plan" as const };
    const planGuard = approvalGuard(["shell"], askCounter, planState);
    for (const [name, args] of [
      ["shell", { cmd: "npm i" }],
      ["write_file", { path: "x.ts" }],
      ["edit_file", { path: "x.ts" }],
    ] as const) {
      const v = await planGuard.check({ sessionKey: "pm", messages: [], call: call(name, args), args });
      if (v.action !== "deny" || !v.message?.includes("plan mode")) {
        fail(`plan mode should deny ${name}, got ${JSON.stringify(v)}`);
      }
    }
    // Read-only tools sail through plan mode.
    const read = await planGuard.check({ sessionKey: "pm", messages: [], call: call("read_file", { path: "x" }) });
    if (read.action !== "continue") fail("plan mode must not block read-only tools");
    if (counter.asks !== 0) fail("plan mode should never reach the human gate");

    const editState = { autoApprove: false, mode: "acceptEdits" as const };
    const editGuard = approvalGuard(["shell"], askCounter, editState);
    const w = await editGuard.check({ sessionKey: "ae", messages: [], call: call("write_file", { path: "x" }) });
    if (w.action !== "continue") fail("acceptEdits should auto-approve file edits");
    const sh = await editGuard.check({ sessionKey: "ae", messages: [], call: call("shell", { cmd: "npm i" }) });
    if (sh.action !== "deny" || (counter.asks as number) !== 1) fail("acceptEdits must still gate shell via the human");
    ok("permission modes: plan (deny all mutating, 0 asks) + acceptEdits (edits auto, shell gated)");
  }

  // ── user hooks: beforeTool exit 2 vetoes the call ──
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-hooks-"));
    try {
      // The hook script reads the JSON payload from stdin and vetoes `shell`.
      const hookScript = path.join(tmp, "veto-shell.js");
      fs.writeFileSync(
        hookScript,
        "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);process.exit(j.call && j.call.name === 'shell' ? 2 : 0)});",
      );
      const hooks = { beforeTool: `node ${hookScript}`, onTurnEnd: undefined as string | undefined }; // no quotes: cmd /s mangles them
      const hg = userHooksGuard({ workspace: tmp, hooks });
      const denied = await hg[0].check({
        sessionKey: "h",
        messages: [],
        call: call("shell", { cmd: "rm -rf /" }),
        args: { cmd: "rm -rf /" },
      });
      if (denied.action !== "deny" || !denied.message?.includes("beforeTool hook")) {
        fail(`beforeTool veto broken: ${JSON.stringify(denied)}`);
      }
      const allowed = await hg[0].check({
        sessionKey: "h",
        messages: [],
        call: call("read_file", { path: "x" }),
        args: { path: "x" },
      });
      if (allowed.action !== "continue") fail("hook must pass non-target tools");
      ok("user hooks: beforeTool JSON payload + exit-2 veto, other tools pass");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ── todo_write: the session task list ──
  {
    const todo = makeTodoTool();
    const out = await todo.execute({
      todos: [
        { content: "research harnesses", status: "completed" },
        { content: "implement features", status: "in_progress" },
        { content: "write docs", status: "pending" },
      ],
    });
    if (!out.includes("1/3 done") || !out.includes("[x] research harnesses") || !out.includes("[~] implement features") || !out.includes("[ ] write docs")) {
      fail(`todo render broken: ${JSON.stringify(out)}`);
    }
    const cleared = await todo.execute({ todos: [] });
    if (!cleared.includes("cleared")) fail("empty todos should clear the list");
    ok("todo_write: full-replace task list with rendered statuses");
  }

  // ── background shell: task ids, task_output polling, task_kill ──
  {
    // Script files instead of node -e: cmd.exe /s mangles embedded quotes.
    const bgDir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-bg-"));
    const job = path.join(bgDir, "job.js");
    fs.writeFileSync(job, "console.log('bg-line-1'); setTimeout(()=>{console.log('bg-done'); process.exit(0)}, 300);");
    const sleeper = path.join(bgDir, "sleep.js");
    fs.writeFileSync(sleeper, "setInterval(()=>{}, 1000);");
    const [sh, taskOut, taskKill] = makeShellTools(process.cwd());
    const started = await sh.execute({ cmd: `node ${job}`, background: true });
    const idMatch = started.match(/task (task_[a-z0-9]+)/);
    if (!idMatch) fail(`background shell should return a task id, got ${started}`);
    const id = idMatch![1];
    const polled = await taskOut.execute({ task_id: id, wait_ms: 5000 });
    if (!polled.includes("bg-line-1") || !polled.includes("bg-done") || !polled.includes("completed")) {
      fail(`task_output polling broken: ${JSON.stringify(polled)}`);
    }
    const killer = await sh.execute({ cmd: `node ${sleeper}`, background: true });
    const killerId = (killer.match(/task (task_[a-z0-9]+)/) ?? [])[1];
    if (killerId) {
      const killed = await taskKill.execute({ task_id: killerId });
      if (!killed.includes("failed (exit") && !killed.includes("running after")) {
        // On some platforms kill is slightly async; accept either state but output must be present.
        if (!killed.includes("(no output)")) fail(`task_kill output broken: ${JSON.stringify(killed)}`);
      }
      const after = await taskOut.execute({ task_id: killerId, wait_ms: 300 });
      if (!after.includes("failed") && !after.includes("exit")) fail(`killed task should report failure, got ${after}`);
    }
    const missing = await taskOut.execute({ task_id: "task_nope" });
    if (!missing.startsWith("error: no such task")) fail("unknown task id should error clearly");
    fs.rmSync(bgDir, { recursive: true, force: true });
    ok("background shell: task id → task_output polling → task_kill");
  }

  // ── OpenAI-compatible provider: streaming SSE + tool calls + usage ──
  await withServer(
    (srv) => srv.on("request", (req, res) => {
      if (req.url?.includes("/chat/completions")) {
        sse(res, [
          JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking hard" } }] }),
          JSON.stringify({ choices: [{ delta: { content: "Hel" } }] }),
          JSON.stringify({ choices: [{ delta: { content: "lo" } }] }),
          JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "echo_tool", arguments: '{"n":1}' } }] } }] }),
          JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
          "[DONE]",
        ]);
        return;
      }
      res.writeHead(404);
      res.end();
    }),
    async (base) => {
      const p = new OpenAIProvider(base, undefined, "test-model");
      const r = await p.chat(
        [{ role: "user", content: "hi" }],
        [{ type: "function", function: { name: "echo_tool", description: "x", parameters: {} } }],
      );
      if (r.content !== "Hello") fail(`openai stream content, got ${JSON.stringify(r.content)}`);
      if (r.toolCalls.length !== 1 || r.toolCalls[0].function.name !== "echo_tool") fail("openai tool call not parsed");
      if ((parseJsonArgs(r.toolCalls[0].function.arguments) as { n: number }).n !== 1) fail("openai tool args not parsed");
      if (r.usage?.inputTokens !== 10 || r.usage.outputTokens !== 5) fail("openai usage not mapped");
      if (r.reasoning !== "thinking hard") fail(`reasoning_content not parsed, got ${JSON.stringify(r.reasoning)}`);
      ok("OpenAI provider: streaming + reasoning_content + tool call + usage (fake server)");
    },
  );

  // ── Anthropic provider: content blocks + tool_use + usage ──
  await withServer(
    (srv) => srv.on("request", (req, res) => {
      if (req.url?.includes("/messages")) {
        sse(res, [
          JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 12, cache_read_input_tokens: 3 } } }),
          JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
          JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }),
          JSON.stringify({ type: "content_block_stop", index: 0 }),
          JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "echo_tool", input: {} } }),
          JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"n":1}' } }),
          JSON.stringify({ type: "content_block_stop", index: 1 }),
          JSON.stringify({ type: "message_delta", usage: { output_tokens: 7 } }),
          JSON.stringify({ type: "message_stop" }),
        ]);
        return;
      }
      res.writeHead(404);
      res.end();
    }),
    async (base) => {
      const p = new AnthropicProvider("test-key", "claude-test", base + "/messages");
      const r = await p.chat([{ role: "user", content: "hi" }], []);
      if (r.content !== "Hello") fail(`anthropic stream content, got ${JSON.stringify(r.content)}`);
      if (r.toolCalls.length !== 1 || r.toolCalls[0].function.name !== "echo_tool") fail("anthropic tool_use not parsed");
      if ((parseJsonArgs(r.toolCalls[0].function.arguments) as { n: number }).n !== 1) fail("anthropic args not parsed");
      if (r.usage?.inputTokens !== 12 || r.usage.cacheReadTokens !== 3 || r.usage.outputTokens !== 7) {
        fail(`anthropic usage mismatch: ${JSON.stringify(r.usage)}`);
      }
      ok("Anthropic provider: streaming + tool_use + usage (against fake server)");
    },
  );

  // ── fs tools v1.5: paged numbered reads, atomic no-clobber move, confined delete ──
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "claw-fs-"));
    fs.writeFileSync(path.join(ws, "num.txt"), Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join("\n"));
    const [readFile, , , , del, mov] = makeFsTools(ws);
    const paged = await readFile.execute({ path: "num.txt", offset: 3, limit: 2 });
    if (!paged.startsWith("3\tL3") || !paged.includes("4\tL4") || !paged.includes('"offset":5')) {
      fail(`read pagination broken: ${JSON.stringify(paged)}`);
    }
    const fromTop = await readFile.execute({ path: "num.txt" });
    if (!fromTop.includes("1\tL1") || !fromTop.includes("10\tL10")) fail("read should number every line");
    try { await readFile.execute({ path: "../out" }); fail("read_file must confine"); } catch { /* expected */ }
    fs.writeFileSync(path.join(ws, "keep.txt"), "x");
    const moved = await mov.execute({ from: "keep.txt", to: "nested/keep.txt" });
    if (!fs.existsSync(path.join(ws, "nested", "keep.txt")) || !moved.includes("moved")) fail("move_file broken: " + moved);
    try { await mov.execute({ from: "num.txt", to: "nested/keep.txt" }); fail("move_file must refuse to clobber"); } catch { /* expected */ }
    if (!(await del.execute({ path: "nested/keep.txt" })).startsWith("deleted")) fail("delete_file broken");
    try { await del.execute({ path: "nested" }); fail("delete_file must refuse directories"); } catch { /* expected */ }
    try { await del.execute({ path: "../../outside.txt" }); fail("delete_file must confine"); } catch { /* expected */ }
    fs.rmSync(ws, { recursive: true, force: true });
    ok("read_file pagination + line numbers; move_file no-clobber; delete_file files-only + confined");
  }

  // ── edit_file v1.5: atomic multi-edit (all-or-nothing) + legacy single form ──
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "claw-edit-"));
    const target = path.join(ws, "e.txt");
    fs.writeFileSync(target, "alpha\nbeta\ngamma");
    const ed = makeEditTool(ws);
    try {
      await ed.execute({ path: "e.txt", edits: [{ old_string: "alpha", new_string: "ALPHA" }, { old_string: "NOPE", new_string: "X" }] });
      fail("atomic edits must throw when an old_string is missing");
    } catch { /* expected */ }
    if (fs.readFileSync(target, "utf8") !== "alpha\nbeta\ngamma") fail("a failed edit in the array must leave the file untouched");
    const r = await ed.execute({ path: "e.txt", edits: [{ old_string: "alpha", new_string: "ALPHA" }, { old_string: "gamma", new_string: "GAMMA" }] });
    if (!r.includes("2 replacement(s)")) fail("multi-edit count: " + r);
    if (fs.readFileSync(target, "utf8") !== "ALPHA\nbeta\nGAMMA") fail("multi-edit content wrong");
    await ed.execute({ path: "e.txt", old_string: "beta", new_string: "BETA" });
    if (!fs.readFileSync(target, "utf8").includes("BETA")) fail("legacy single-edit form broke");
    fs.rmSync(ws, { recursive: true, force: true });
    ok("edit_file: atomic multi-edit array (all-or-nothing) + legacy single edit");
  }

  // ── grep/glob v1.5: context, files_only, literal, case, multiline, limits ──
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "claw-grep-"));
    fs.writeFileSync(path.join(ws, "g.txt"), "HEAD\nmid\nTAIL");
    const [glob, grep] = makeSearchTools(ws);
    const ctx = await grep.execute({ pattern: "mid", context_before: 1, context_after: 1 });
    if (!ctx.includes("g.txt:1- HEAD") || !ctx.includes("g.txt:2: mid") || !ctx.includes("g.txt:3- TAIL")) {
      fail(`grep context lines broken: ${JSON.stringify(ctx)}`);
    }
    const fo = await grep.execute({ pattern: "m", files_only: true });
    if (fo.trim() !== "g.txt") fail("grep files_only: " + JSON.stringify(fo));
    const lit = await grep.execute({ pattern: "m.d", literal: true });
    if (!lit.includes("no matches")) fail("grep literal must treat '.' literally: " + lit);
    const cs = await grep.execute({ pattern: "head", case_sensitive: true });
    if (!cs.includes("no matches")) fail("grep case_sensitive must miss 'HEAD': " + cs);
    const ci = await grep.execute({ pattern: "head" });
    if (!ci.includes("HEAD")) fail("grep must default to case-insensitive");
    const ml = await grep.execute({ pattern: "HEAD.*TAIL", multiline: true });
    if (!ml.includes("HEAD mid TAIL")) fail("grep multiline: " + JSON.stringify(ml));
    fs.writeFileSync(path.join(ws, "h.txt"), "z");
    const g = await glob.execute({ pattern: "*.txt", head_limit: 1 });
    if (g.split("\n").length !== 1) fail("glob head_limit: " + g);
    fs.rmSync(ws, { recursive: true, force: true });
    ok("grep: context/files_only/literal/case/multiline + glob head_limit");
  }

  // ── parallel read-only batch: consecutive read calls overlap, order kept ──
  {
    let active = 0;
    let maxActive = 0;
    const mkSlow = (name: string, out: string): Tool => ({
      name,
      description: "t",
      parameters: { type: "object", properties: {} },
      risk: "read",
      cacheable: false,
      execute: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 25));
        active--;
        return out;
      },
    });
    const twoCalls = [
      { id: "c1", type: "function" as const, function: { name: "slow_a", arguments: "{}" } },
      { id: "c2", type: "function" as const, function: { name: "slow_b", arguments: "{}" } },
    ];
    const parProv: Provider = {
      name: "par",
      model: "p",
      streamable: false,
      async chat(msgs) {
        if (msgs[msgs.length - 1].role === "tool") return { content: "done", toolCalls: [], usage: null };
        return { content: "", toolCalls: twoCalls, usage: null };
      },
    };
    const parAgent = new Agent(
      parProv,
      [mkSlow("slow_a", "RESULT-A"), mkSlow("slow_b", "RESULT-B")],
      { maxIterations: 4, verbose: false, compactAt: 50, log: () => {}, onText: () => {} },
    );
    const out = await parAgent.runTurn("par", [{ role: "system", content: "s" }, { role: "user", content: "go" }]);
    const toolMsgs = out.history.filter((m) => m.role === "tool");
    if (toolMsgs.length !== 2 || toolMsgs[0].content !== "RESULT-A" || toolMsgs[1].content !== "RESULT-B") {
      fail("parallel batch must keep one result per call, in order");
    }
    if (maxActive < 2) fail(`two consecutive read-only calls should overlap (maxActive=${maxActive})`);
    if (out.toolCallsMade !== 2) fail("toolCallsMade should count both calls");
    ok("parallel read-only batch: consecutive reads overlap, results land in call order");
  }

  // ── withRetry: transient recovers, fatal fails fast, abort stops the loop ──
  {
    let n = 0;
    const v = await withRetry(async () => {
      n++;
      if (n === 1) throw new RetryableError("transient");
      return "fine";
    }, { baseMs: 1 });
    if (v !== "fine" || n !== 2) fail("withRetry should recover after one transient error");
    let m = 0;
    try {
      await withRetry(async () => {
        m++;
        throw new Error("fatal");
      }, { baseMs: 1 });
      fail("plain errors must not be retried");
    } catch { /* expected */ }
    if (m !== 1) fail(`non-retryable error must fail fast, attempts=${m}`);
    const ac = new AbortController();
    let k = 0;
    try {
      await withRetry(async () => {
        k++;
        ac.abort();
        throw new RetryableError("x");
      }, { attempts: 5, baseMs: 1000, signal: ac.signal });
      fail("abort must stop the retry loop");
    } catch { /* expected */ }
    if (k !== 1) fail(`aborted retry loop must stop, attempts=${k}`);
    if (!isRetryableStatus(429) || !isRetryableStatus(503) || isRetryableStatus(400) || isRetryableStatus(404)) {
      fail("isRetryableStatus classification");
    }
    ok("withRetry: transient recovers, fatal fails fast, abort stops retries");
  }

  // ── environment-aware system prompt ──
  {
    const sp = Agent.systemPrompt(process.cwd());
    if (!sp.includes("Runtime:") || !sp.includes(`Node ${process.version}`)) fail("system prompt must carry environment context");
    if (!sp.includes("Date:") || !sp.includes("line-numbered")) fail("system prompt must teach numbered reads + date awareness");
    ok("system prompt: OS/Node/date context + numbered-read + parallel-lookup guidance");
  }

  // ── REPL power helpers: /export transcript, # memory, Tab completion, /usage math ──
  {
    const hist: ChatMsg[] = [
      { role: "system", content: "s" },
      { role: "user", content: "hello there" },
      {
        role: "assistant",
        content: "hi!",
        tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "file contents" },
    ];
    const est = contextEstimate(hist);
    if (est.messages !== 4 || est.approxTokens !== Math.round(est.chars / 4)) fail("contextEstimate math");
    const md = exportMarkdown(hist, { id: "sess_x", model: "m", workspace: "/w" });
    if (!md.includes("# CLAW session sess_x") || !md.includes("## User") || !md.includes("## Assistant")) fail("exportMarkdown structure");
    if (!md.includes("### Tool call — `read_file`") || !md.includes("file contents")) fail("exportMarkdown must include tool calls + results");
    if (!md.includes("hello there")) fail("exportMarkdown must include user text");

    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "claw-mem-"));
    const memo = appendMemoryNote(ws, "prefer bun over npm here");
    const file = fs.readFileSync(memo.file, "utf8");
    if (!memo.created || !file.includes("## Memory notes") || !file.includes("prefer bun over npm here")) fail("appendMemoryNote first write");
    const memo2 = appendMemoryNote(ws, "second note");
    const file2 = fs.readFileSync(memo2.file, "utf8");
    if (memo2.created || (file2.match(/## Memory notes/g) ?? []).length !== 1 || !file2.includes("second note")) {
      fail("appendMemoryNote must reuse the Memory notes section");
    }
    const [hits] = completeSlash("/expo", ws, os.tmpdir());
    if (hits.length !== 1 || hits[0] !== "/export") fail(`completeSlash prefix: ${JSON.stringify(hits)}`);
    const [all, part] = completeSlash("/", ws, os.tmpdir());
    if (!all.includes("/help") || !all.includes("/export") || part !== "/") fail("completeSlash on bare / lists commands");
    if (!BUILTIN_SLASH.includes("usage") || !BUILTIN_SLASH.includes("allow")) fail("BUILTIN_SLASH must list the new commands");
    fs.rmSync(ws, { recursive: true, force: true });
    ok("REPL helpers: /export transcript, # memory notes, Tab completion, /usage estimate");
  }

  console.log("\nOK — all checks passed.");
}

async function withServer(
  register: (server: http.Server) => void,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer();
  register(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}/v1`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

function sse(res: http.ServerResponse, events: string[]): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const e of events) res.write(`data: ${e}\n\n`);
  res.end();
}


export type { Usage };
