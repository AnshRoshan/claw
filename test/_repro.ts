import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { McpClient } from "../src/mcp.ts";
import { setOpenBrowserHook } from "../src/oauth.ts";

const state: { challenge?: string; issuedCode?: string } = {};
const server = http.createServer((req, res) => {
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const url = req.url ?? "/";
  const readBody = (cb: (b: string) => void) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => cb(b));
  };
  console.log("REQ", req.method, url, "auth=", req.headers.authorization ?? "(none)");
  if (url === "/.well-known/oauth-authorization-server") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ registration_endpoint: base + "/register", authorization_endpoint: base + "/authorize", token_endpoint: base + "/token", scopes_supported: ["read"] }));
    return;
  }
  if (url === "/register") {
    readBody(() => { res.writeHead(200, {"content-type":"application/json"}); res.end(JSON.stringify({ client_id: "dyn-1" })); });
    return;
  }
  if (url.startsWith("/authorize")) {
    const q = new URL(url, base).searchParams;
    state.challenge = q.get("code_challenge")!;
    state.issuedCode = "code-42";
    const redirect = new URL(q.get("redirect_uri")!);
    redirect.searchParams.set("code", "code-42");
    redirect.searchParams.set("state", q.get("state") ?? "");
    res.writeHead(302, { location: redirect.toString() });
    res.end();
    return;
  }
  if (url === "/token") {
    readBody((body) => {
      const form = new URLSearchParams(body);
      console.log("TOKEN grant=", form.get("grant_type"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 }));
    });
    return;
  }
  if (url === "/mcp") {
    readBody((body) => {
      if (req.headers.authorization !== "Bearer at-1") { res.writeHead(401); res.end(); return; }
      const msg = JSON.parse(body) as { id: number; method?: string };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "t" }] } })}\n\n`);
      res.end();
    });
    return;
  }
  res.writeHead(404); res.end();
});
server.listen(0, "127.0.0.1", async () => {
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.CLAW_TOKENS_DIR = "/tmp/claw-oauth-test";
  setOpenBrowserHook(async (u) => {
    const r = await fetch(u, { redirect: "manual" });
    await fetch(r.headers.get("location")!);
  });
  const client = new McpClient("oauth-x", { url: base + "/mcp", transport: "http", oauth: { authServer: base } });
  try {
    const tools = await client.connect();
    console.log("TOOLS", JSON.stringify(tools));
  } catch (e) { console.log("ERR", (e as Error).message); }
  await client.close();
  server.close();
  process.exit(0);
});
