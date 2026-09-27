// extension.js — CLAW for VS Code. A thin client of `claw serve`: this file
// contains NO agent logic. It (1) attaches to — or spawns — a running
// `claw serve` process, (2) opens a chat webview, (3) relays messages
// between the webview (which cannot fetch localhost itself) and the
// /chat HTTP channel. See README.md for the architecture diagram.

const vscode = require("vscode");
const { spawn } = require("node:child_process");
const http = require("node:http");

let panel = null;
let serveProc = null;

function cfg() {
  return vscode.workspace.getConfiguration("claw");
}

function baseUrl() {
  return (cfg().get("serverUrl") || "http://127.0.0.1:8787").replace(/\/+$/, "");
}

/** GET {base}/health → null when unreachable. */
function health(base) {
  return new Promise((resolve) => {
    const req = http.get(base + "/health", { timeout: 1500 }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

/** POST {base}/chat with {message, session_id, stream} — SSE via callback:
 * onDelta(text) fires per token, resolves with the final `done` payload. */
function chatStream(base, message, sessionId, onDelta, onTool) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ message, session_id: sessionId, stream: true });
    const req = http.request(
      base + "/chat",
      { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: 300_000 },
      (res) => {
        if (!(res.headers["content-type"] || "").includes("text/event-stream")) {
          // Server without streaming support — fall back to plain JSON.
          let data = "";
          res.on("data", (d) => (data += d));
          res.on("end", () => {
            try {
              resolve(JSON.parse(data));
            } catch (err) {
              reject(new Error("claw serve returned non-JSON: " + data.slice(0, 200)));
            }
          });
          return;
        }
        let buf = "";
        res.on("data", (chunk) => {
          buf += chunk.toString();
          const frames = buf.split("\n\n");
          buf = frames.pop() || "";
          for (const frame of frames) {
            const line = frame.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            let j;
            try {
              j = JSON.parse(line.slice(5));
            } catch {
              continue;
            }
            if (j.type === "text" && onDelta) onDelta(j.delta);
            if (j.type === "tool" && onTool) onTool(j);
            if (j.type === "done") resolve(j);
            if (j.type === "error") reject(new Error(j.error));
          }
        });
        res.on("end", () => reject(new Error("claw serve stream ended without a done event")));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("claw serve timed out"));
    });
    req.end(body);
  });
}

/** POST {base}/chat with {message, session_id} → parsed JSON. */
function chat(base, message, sessionId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ message, session_id: sessionId });
    const req = http.request(
      base + "/chat",
      { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: 300_000 },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error("claw serve returned non-JSON: " + data.slice(0, 200)));
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("claw serve timed out"));
    });
    req.end(body);
  });
}

/** Attach to the configured server, or spawn one from claw.cliPath. */
async function ensureServer() {
  const base = baseUrl();
  const h = await health(base);
  if (h) return base;

  const cliPath = cfg().get("cliPath");
  if (!cliPath) {
    throw new Error(
      `no claw serve at ${base} and no claw.cliPath configured — run \`claw serve --port 8787\` or set "claw.cliPath"`,
    );
  }
  const isPath = /[\\/]/.test(cliPath);
  const cmd = isPath ? process.execPath : "claw";
  const args = isPath ? [cliPath, "-y", "serve", "--port", "8787"] : ["serve", "--port", "8787"];
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  serveProc = spawn(cmd, args, {
    cwd: workspace || undefined,
    env: process.env,
    stdio: "ignore",
    detached: false,
  });
  serveProc.on("error", (err) => vscode.window.showErrorMessage(`claw serve failed to start: ${err.message}`));
  // Wait for /health to come up (max ~10s).
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await health(base)) return base;
  }
  throw new Error(`claw serve did not come up at ${base} within 10s`);
}

function stopServer() {
  if (serveProc) {
    serveProc.kill();
    serveProc = null;
  }
}

// ── the chat webview ────────────────────────────────────────────────

function panelHtml(base, workspace) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { margin:0; font:13px/1.55 var(--vscode-font-family); color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); display:flex; flex-direction:column; height:100vh; }
  #chat { flex:1; overflow-y:auto; padding:10px 12px; }
  .msg { margin:0 0 10px; white-space:pre-wrap; word-break:break-word; }
  .you { color: var(--vscode-textLink-foreground); }
  .you::before { content:"you ❯ "; font-weight:600; }
  .claw::before { content:"claw ❯ "; color: var(--vscode-testing-iconPassed, #7ee787); font-weight:600; }
  .err { color: var(--vscode-errorForeground); }
  .meta { opacity:.65; font-size:11px; margin-top:2px; }
  form { display:flex; gap:6px; padding:8px 10px; border-top:1px solid var(--vscode-panel-border); }
  input { flex:1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border:1px solid var(--vscode-input-border); padding:7px 9px; font:inherit; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border:0; padding:7px 14px; font:inherit; cursor:pointer; }
  button:disabled { opacity:.5; }
</style></head>
<body>
<div id="chat"></div>
<form id="f"><input id="m" placeholder="Ask claw about this workspace…"><button>send</button></form>
<script>
  const vscode = acquireVsCodeApi();
  const chat = document.getElementById("chat");
  const form = document.getElementById("f");
  const input = document.getElementById("m");
  const btn = form.querySelector("button");
  function add(cls, text, meta) {
    const el = document.createElement("div"); el.className = "msg " + cls; el.textContent = text;
    if (meta) { const s = document.createElement("div"); s.className = "meta"; s.textContent = meta; el.appendChild(s); }
    chat.appendChild(el); chat.scrollTop = chat.scrollHeight; return el;
  }
  let sendBusy = false, liveEl = null, liveText = "";
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (sendBusy) return;
    const message = input.value.trim(); if (!message) return;
    input.value = ""; add("you", message); sendBusy = true; btn.disabled = true;
    liveEl = add("claw", ""); liveText = "";
    vscode.postMessage({ type: "chat", message });
  });
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "delta" && liveEl) {
      liveText += m.delta;
      liveEl.textContent = liveText;
      chat.scrollTop = chat.scrollHeight;
      return;
    }
    if (m.type === "tool") {
      const t = document.createElement("div");
      t.className = "meta";
      t.textContent = (m.kind === "tool-start" ? "▶ " : m.ok ? "◀ " : "✗ ") + m.name + "  " + (m.detail || "");
      chat.appendChild(t);
      chat.scrollTop = chat.scrollHeight;
      return;
    }
    if (m.type === "reply" || m.type === "error") {
      if (liveEl) liveEl.remove();
      liveEl = null; sendBusy = false; btn.disabled = false;
      if (m.type === "reply") add(m.aborted ? "err" : "claw", m.answer, m.meta);
      else add("err", m.error);
      input.focus();
    }
  });
  input.focus();
</script>
</body></html>`;
}

function openPanel(context) {
  if (panel) {
    panel.reveal();
    return panel;
  }
  panel = vscode.window.createWebviewPanel("clawChat", "CLAW", vscode.ViewColumn.Beside, {
    enableScripts: true,
  });
  panel.webview.html = panelHtml(baseUrl(), vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "(no folder)");
  panel.onDidDispose(() => (panel = null));
  // The bridge: webview ↔ extension host ↔ claw serve (streamed).
  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type !== "chat") return;
    try {
      const base = await ensureServer();
      const sessionId = context.workspaceState.get("claw.sessionId") || undefined;
      const reply = await chatStream(
        base,
        msg.message,
        sessionId,
        (delta) => panel?.webview.postMessage({ type: "delta", delta }),
        (tool) => panel?.webview.postMessage({ type: "tool", ...tool }),
      );
      if (reply.session_id) void context.workspaceState.update("claw.sessionId", reply.session_id);
      panel?.webview.postMessage({
        type: "reply",
        answer: reply.answer,
        aborted: reply.aborted,
        meta: reply.tool_calls
          ? `${reply.tool_calls} tool call${reply.tool_calls === 1 ? "" : "s"} · in ${reply.usage.input} · out ${reply.usage.output}`
          : null,
      });
    } catch (err) {
      panel?.webview.postMessage({ type: "error", error: err.message });
    }
  });
  return panel;
}

async function sendToChat(context, message) {
  const p = openPanel(context);
  try {
    const base = await ensureServer();
    const sessionId = context.workspaceState.get("claw.sessionId") || undefined;
    const reply = await chat(base, message, sessionId);
    if (reply.session_id) void context.workspaceState.update("claw.sessionId", reply.session_id);
    p.webview.postMessage({
      type: "reply",
      answer: reply.answer,
      aborted: reply.aborted,
      meta: reply.tool_calls
        ? `${reply.tool_calls} tool call${reply.tool_calls === 1 ? "" : "s"} · in ${reply.usage.input} · out ${reply.usage.output}`
        : null,
    });
  } catch (err) {
    p.webview.postMessage({ type: "error", error: err.message });
  }
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("claw.openChat", async () => {
      try {
        await ensureServer();
        openPanel(context);
      } catch (err) {
        vscode.window.showErrorMessage(`CLAW: ${err.message}`);
      }
    }),
    vscode.commands.registerCommand("claw.explainSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showInformationMessage("CLAW: select some code first");
        return;
      }
      const rel = vscode.workspace.asRelativePath(editor.document.uri);
      const range = `L${editor.selection.start.line + 1}-${editor.selection.end.line + 1}`;
      const code = editor.document.getText(editor.selection);
      const message = `Explain this code from <file>${rel}:${range}</file> and point out anything suspicious:\n\n\`\`\`\n${code.slice(0, 8000)}\n\`\`\``;
      try {
        await sendToChat(context, message);
      } catch (err) {
        vscode.window.showErrorMessage(`CLAW: ${err.message}`);
      }
    }),
    vscode.commands.registerCommand("claw.fixDiagnostic", async (uri, diagnostic) => {
      const editor = vscode.window.activeTextEditor;
      const doc = uri ? await vscode.workspace.openTextDocument(uri) : editor?.document;
      if (!doc || !diagnostic) return;
      const rel = vscode.workspace.asRelativePath(doc.uri);
      const line = diagnostic.range.start.line + 1;
      const snippet = doc.getText(new vscode.Range(diagnostic.range.start, diagnostic.range.end)) ||
        doc.getText(new vscode.Range(Math.max(0, diagnostic.range.start.line - 2), 0, diagnostic.range.end.line + 3, 0));
      const message =
        `Fix this diagnostic in <file>${rel}:${line}</file>:\n` +
        `severity: ${vscode.DiagnosticSeverity[diagnostic.severity] ?? diagnostic.severity}\n` +
        `message: ${diagnostic.message}\n` +
        `source: ${diagnostic.source ?? "unknown"}\n\n` +
        "```\n" + snippet.slice(0, 4000) + "\n```\n" +
        "Use read_file/edit_file to inspect and fix it, then verify.";
      try {
        await sendToChat(context, message);
      } catch (err) {
        vscode.window.showErrorMessage(`CLAW: ${err.message}`);
      }
    }),
    vscode.commands.registerCommand("claw.restartServer", () => {
      stopServer();
      void context.workspaceState.update("claw.sessionId", undefined);
      vscode.window.showInformationMessage("CLAW: server stopped — next message starts a fresh process and session");
    }),
    // "Claw: Fix this" code lens on every editor diagnostic.
    vscode.languages.registerCodeLensProvider(
      [{ scheme: "file" }],
      {
        provideCodeLenses(doc) {
          const lenses = [];
          for (const diagnostic of vscode.languages.getDiagnostics(doc.uri)) {
            if (diagnostic.severity === vscode.DiagnosticSeverity.Hint) continue;
            lenses.push(
              new vscode.CodeLens(diagnostic.range, {
                title: "Claw: Fix this",
                command: "claw.fixDiagnostic",
                arguments: [doc.uri, diagnostic],
              }),
            );
          }
          return lenses;
        },
      },
    ),
  );
}

function deactivate() {
  stopServer();
}

module.exports = { activate, deactivate };
