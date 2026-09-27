// oauth.ts — browser-based OAuth 2.0 Authorization Code + PKCE for remote
// MCP servers, the last piece of the MCP auth story. Built from scratch
// (zero dependencies) with the same philosophy as the SSE parsers: the wire
// formats are the contract, so we implement them rather than import them.
//
// Flow (RFC 6749 §4.1 + RFC 7636 + RFC 7591, per the MCP auth spec):
//   1. discover   — find the authorization server's metadata via well-known
//                   URIs (protected-resource → authorization-server), or use
//                   a configured authServer base URL.
//   2. register   — dynamic client registration (unless a clientId is given).
//   3. authorize  — generate a PKCE verifier/challenge, start a one-shot
//                   local HTTP callback server, open the user's browser.
//   4. exchange   — swap the authorization code + code_verifier for tokens.
//   5. store      — tokens persist in ~/.claw/mcp-tokens.json; refresh uses
//                   the refresh_token grant when expired.
//
// The browser step is injectable (setOpenBrowserHook) so tests can simulate
// the identity provider end-to-end without a real browser.

import { createHash, randomBytes } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { ensureDir } from "./util.ts";

/** Per-server OAuth options — the value of McpServerCfg.oauth. */
export interface OAuthSpec {
  /** Authorization server base URL; skips well-known discovery when set. */
  authServer?: string;
  /** Scopes to request (default: from server metadata, else none). */
  scopes?: string[];
  /** Pre-registered client id — skips dynamic registration when set. */
  clientId?: string;
  clientSecret?: string;
}

export interface AuthServerMetadata {
  issuer?: string;
  registration_endpoint?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  scopes_supported?: string[];
  response_types_supported?: string[];
  grant_types_supported?: string[];
}

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  /** Epoch ms when the access token expires (30s clock skew allowed). */
  expires_at?: number;
  client_id?: string;
  scopes?: string[];
}

// ── token persistence ───────────────────────────────────────────────

function tokensFile(): string {
  return process.env.CLAW_TOKENS_DIR
    ? path.join(process.env.CLAW_TOKENS_DIR, "mcp-tokens.json")
    : path.join(homedir(), ".claw", "mcp-tokens.json");
}

function readAllTokens(): Record<string, TokenSet> {
  try {
    return JSON.parse(fs.readFileSync(tokensFile(), "utf8")) as Record<string, TokenSet>;
  } catch {
    return {};
  }
}

function writeAllTokens(all: Record<string, TokenSet>): void {
  ensureDir(path.dirname(tokensFile()));
  fs.writeFileSync(tokensFile(), JSON.stringify(all, null, 2) + "\n");
}

export function loadToken(serverName: string): TokenSet | undefined {
  return readAllTokens()[serverName];
}

export function saveToken(serverName: string, token: TokenSet): void {
  const all = readAllTokens();
  all[serverName] = token;
  writeAllTokens(all);
}

export function forgetToken(serverName: string): void {
  const all = readAllTokens();
  delete all[serverName];
  writeAllTokens(all);
}

/** The stored access token, or null. Expired tokens return null. */
export function validToken(serverName: string): string | null {
  const tok = loadToken(serverName);
  if (!tok?.access_token) return null;
  if (tok.expires_at !== undefined && Date.now() >= tok.expires_at - 30_000) return null;
  return tok.access_token;
}

// ── PKCE (RFC 7636) ─────────────────────────────────────────────────

export function makePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// ── well-known discovery ────────────────────────────────────────────

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Find the authorization server metadata for an MCP endpoint:
 *   1. an explicitly configured authServer base URL, else
 *   2. the MCP spec's protected-resource metadata → authorization_servers, else
 *   3. well-known on the MCP endpoint's own origin.
 */
export async function discoverAuthServer(mcpUrl: string, spec: OAuthSpec): Promise<AuthServerMetadata | null> {
  const url = new URL(mcpUrl);
  const bases: string[] = [];
  if (spec.authServer) bases.push(spec.authServer.replace(/\/+$/, ""));

  const pr = await getJson<{ authorization_servers?: string[] }>(
    `${url.origin}/.well-known/oauth-protected-resource${url.pathname === "/" ? "" : url.pathname}`,
  );
  for (const server of pr?.authorization_servers ?? []) bases.push(server.replace(/\/+$/, ""));
  bases.push(url.origin);

  for (const base of bases) {
    const md =
      (await getJson<AuthServerMetadata>(`${base}/.well-known/oauth-authorization-server`)) ??
      (await getJson<AuthServerMetadata>(`${base}/.well-known/openid-configuration`));
    if (md?.authorization_endpoint && md?.token_endpoint) return md;
  }
  return null;
}

// ── dynamic client registration (RFC 7591) ──────────────────────────

async function registerClient(
  metadata: AuthServerMetadata,
  redirectUri: string,
  scopes: string[],
): Promise<{ clientId: string; clientSecret?: string }> {
  if (!metadata.registration_endpoint) {
    throw new Error("authorization server exposes no registration_endpoint — configure a pre-registered clientId");
  }
  const resp = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "claw",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: scopes.join(" ") || undefined,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`dynamic client registration failed: HTTP ${resp.status}`);
  const out = (await resp.json()) as { client_id?: string; client_secret?: string };
  if (!out.client_id) throw new Error("dynamic client registration returned no client_id");
  return { clientId: out.client_id, clientSecret: out.client_secret };
}

// ── the browser step ────────────────────────────────────────────────

type OpenBrowser = (url: string) => Promise<void>;

let browserHook: OpenBrowser | null = null;

/** Tests (or embedders) can replace the browser with their own behavior. */
export function setOpenBrowserHook(fn: OpenBrowser | null): void {
  browserHook = fn;
}

function openInRealBrowser(url: string): void {
  if (process.env.CLAW_NO_BROWSER) {
    console.log(`  open this URL to authorize claw:\n  ${url}`);
    return;
  }
  try {
    if (process.platform === "win32") {
      // rundll32 avoids cmd.exe parsing of '&' in query strings.
      spawn("rundll32", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    console.log(`  could not open a browser — open this URL manually:\n  ${url}`);
  }
}

// ── the local callback server ───────────────────────────────────────

interface CallbackServer {
  redirectUri: string;
  /** Resolves with the authorization code when the provider redirects back. */
  nextCode: Promise<{ code: string; state: string }>;
  close: () => void;
}

function startCallbackServer(preferredPort?: number): Promise<CallbackServer> {
  return new Promise<CallbackServer>((resolveServer, rejectServer) => {
    let capture: ((v: { code: string; state: string }) => void) | null = null;
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      const code = u.searchParams.get("code");
      const state = u.searchParams.get("state") ?? "";
      const error = u.searchParams.get("error");
      const page = (status: number, body: string) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
        res.end(body);
      };
      if (error) {
        page(400, `<h1>claw: authorization failed</h1><p>${error}: ${u.searchParams.get("error_description") ?? ""}</p>`);
        capture?.({ code: "", state });
        return;
      }
      if (!code) {
        page(400, "<h1>claw: missing ?code</h1>");
        return;
      }
      page(200, "<h1>claw: authorized ✓</h1><p>You can close this window and return to the terminal.</p>");
      capture?.({ code, state });
    });
    server.on("error", rejectServer);
    server.listen(preferredPort ?? 0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      const timeout = setTimeout(
        () => capture?.({ code: "", state: "timeout" }),
        5 * 60_000,
      );
      resolveServer({
        redirectUri,
        nextCode: new Promise<{ code: string; state: string }>((resolve) => {
          capture = resolve;
        }),
        close: () => {
          clearTimeout(timeout);
          server.close();
        },
      });
    });
  });
}

// ── the full login flow ─────────────────────────────────────────────

/**
 * Run the complete Authorization Code + PKCE flow for one MCP server and
 * persist the resulting tokens. Throws only on setup failures (discovery,
 * registration, exchange) — a user cancelling the browser tab simply
 * rejects the callback promise with a clear message.
 */
export async function mcpOAuthLogin(
  serverName: string,
  mcpUrl: string,
  spec: OAuthSpec = {},
): Promise<TokenSet> {
  const metadata = await discoverAuthServer(mcpUrl, spec);
  if (!metadata) {
    throw new Error(
      `could not discover OAuth metadata for ${mcpUrl} — set "authServer" in the server's oauth config if you know the authorization server`,
    );
  }

  const cb = await startCallbackServer();

  try {
    let clientId = spec.clientId;
    let clientSecret = spec.clientSecret;
    if (!clientId) {
      const registered = await registerClient(metadata, cb.redirectUri, spec.scopes ?? []);
      clientId = registered.clientId;
      clientSecret = registered.clientSecret;
    }

    const { verifier, challenge } = makePkce();
    const state = randomBytes(12).toString("base64url");
    const authUrl = new URL(metadata.authorization_endpoint!);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", cb.redirectUri);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    const scopes = spec.scopes ?? metadata.scopes_supported ?? [];
    if (scopes.length) authUrl.searchParams.set("scope", scopes.join(" "));
    if (clientSecret) authUrl.searchParams.set("client_secret", clientSecret);

    const open = browserHook ?? (async (url: string) => openInRealBrowser(url));
    void open(authUrl.toString());

    const { code, state: returnedState } = await cb.nextCode;
    if (!code) {
      throw new Error(
        returnedState === "timeout" ? "timed out waiting for the OAuth callback (5 minutes)" : "authorization was cancelled",
      );
    }
    if (returnedState !== state) throw new Error("OAuth state mismatch — refusing the callback (possible CSRF)");

    return await exchangeCode(serverName, metadata, {
      code,
      redirectUri: cb.redirectUri,
      clientId,
      clientSecret,
      verifier,
      scopes,
    });
  } finally {
    cb.close();
  }
}

async function exchangeCode(
  serverName: string,
  metadata: AuthServerMetadata,
  p: {
    code: string;
    redirectUri: string;
    clientId: string;
    clientSecret?: string;
    verifier: string;
    scopes: string[];
  },
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: p.code,
    redirect_uri: p.redirectUri,
    client_id: p.clientId,
    code_verifier: p.verifier,
  });
  if (p.clientSecret) body.set("client_secret", p.clientSecret);
  if (p.scopes.length) body.set("scope", p.scopes.join(" "));

  const resp = await fetch(metadata.token_endpoint!, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const detail = (await resp.text().catch(() => "")).slice(0, 200);
    throw new Error(`token exchange failed: HTTP ${resp.status}${detail ? " — " + detail : ""}`);
  }
  const out = (await resp.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!out.access_token) throw new Error("token endpoint returned no access_token");
  const token: TokenSet = {
    access_token: out.access_token,
    refresh_token: out.refresh_token,
    expires_at: out.expires_in ? Date.now() + out.expires_in * 1000 : undefined,
    client_id: p.clientId,
    scopes: p.scopes,
  };
  saveToken(serverName, token);
  return token;
}

/** Refresh an expired access token using its refresh_token grant. */
export async function refreshAccessToken(
  serverName: string,
  mcpUrl: string,
  spec: OAuthSpec = {},
): Promise<TokenSet | null> {
  const stored = loadToken(serverName);
  const metadata = await discoverAuthServer(mcpUrl, spec);
  if (!stored?.refresh_token || !metadata?.token_endpoint) return null;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: stored.refresh_token,
    client_id: stored.client_id ?? spec.clientId ?? "",
  });
  if (spec.clientSecret) body.set("client_secret", spec.clientSecret);
  const resp = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) return null;
  const out = (await resp.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!out.access_token) return null;
  const token: TokenSet = {
    ...stored,
    access_token: out.access_token,
    refresh_token: out.refresh_token ?? stored.refresh_token,
    expires_at: out.expires_in ? Date.now() + out.expires_in * 1000 : undefined,
  };
  saveToken(serverName, token);
  return token;
}

/**
 * Best-effort bearer token for a server: a valid stored token, or a
 * refreshed one. Returns null when the user must log in (`claw mcp login`).
 */
export async function ensureToken(serverName: string, mcpUrl: string, spec: OAuthSpec = {}): Promise<string | null> {
  const valid = validToken(serverName);
  if (valid) return valid;
  const refreshed = await refreshAccessToken(serverName, mcpUrl, spec);
  return refreshed?.access_token ?? null;
}
