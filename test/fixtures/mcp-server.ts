// test/fixtures/mcp-server.ts — a minimal MCP server over stdio
// (newline-delimited JSON-RPC) used by the selfcheck to exercise McpClient
// with zero external dependencies. It implements initialize, tools/list,
// tools/call, ping, sampling/createMessage (server → client), and exit.

import * as readline from "node:readline";

interface JsonRpc {
  jsonrpc: string;
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: { content?: { type?: string; text?: string } | Array<{ type?: string; text?: string }> };
  error?: { code: number; message: string };
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
const send = (msg: unknown): void => {
  process.stdout.write(JSON.stringify(msg) + "\n");
};

// Server → client sampling: send sampling/createMessage, await the response.
const pendingSampling = new Map<number, (r: JsonRpc) => void>();
let nextSamplingId = 1000;
function sample(text: string): Promise<string> {
  return new Promise((resolve) => {
    const id = nextSamplingId++;
    pendingSampling.set(id, (r) => {
      if (r.error) resolve(`sampling error: ${r.error.message}`);
      const c = r.result?.content;
      const text = Array.isArray(c) ? c.map((p) => p.text ?? "").join("") : (c as { text?: string })?.text ?? "";
      resolve(text);
    });
    send({
      jsonrpc: "2.0",
      id,
      method: "sampling/createMessage",
      params: {
        messages: [{ role: "user", content: { type: "text", text } }],
        maxTokens: 100,
      },
    });
  });
}

rl.on("line", (line) => {
  let msg: JsonRpc;
  try {
    msg = JSON.parse(line) as JsonRpc;
  } catch {
    return;
  }
  if (!msg.method && msg.id !== undefined) {
    // A response to one of our sampling requests.
    const cb = pendingSampling.get(msg.id);
    if (cb) {
      pendingSampling.delete(msg.id);
      cb(msg);
    }
    return;
  }
  if (!msg.method) return;

  const reply = (result?: unknown, error?: { code: number; message: string }): void => {
    if (msg.id !== undefined) {
      send({ jsonrpc: "2.0", id: msg.id, result, error });
    }
  };

  switch (msg.method) {
    case "initialize":
      reply({
        protocolVersion: msg.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {}, sampling: {} },
        serverInfo: { name: "fixture-mcp", version: "1.0.0" },
      });
      break;
    case "notifications/initialized":
      break; // notification — no response
    case "tools/list":
      reply({
        tools: [
          {
            name: "echo_tool",
            description: "Echo text back to the caller",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
          {
            name: "web_search",
            description: "Search the web",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
          {
            name: "ask_model",
            description: "Ask the client's model via MCP sampling",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
          {
            name: "delete_everything",
            description: "Dangerous tool used to test the approval mapping",
            inputSchema: { type: "object" },
          },
        ],
      });
      break;
    case "tools/call": {
      const p = msg.params as { name: string; arguments?: Record<string, unknown> };
      const args = p.arguments ?? {};
      void (async () => {
        switch (p.name) {
          case "echo_tool":
            reply({ content: [{ type: "text", text: `echo: ${String(args.text ?? "")}` }], isError: false });
            break;
          case "web_search":
            reply({ content: [{ type: "text", text: "[fixture] 3 results for query" }], isError: false });
            break;
          case "ask_model": {
            const text = await sample(String(args.text ?? ""));
            reply({ content: [{ type: "text", text: `model says: ${text}` }], isError: false });
            break;
          }
          default:
            reply({ content: [{ type: "text", text: `unknown tool ${p.name}` }], isError: true });
        }
      })();
      break;
    }
    case "ping":
      reply({});
      break;
    case "notifications/exit":
      process.exit(0);
      break;
    default:
      reply(undefined, { code: -32601, message: "method not found" });
  }
});
