// util.ts — small, dependency-free helpers.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** 24-bit color ANSI codes — we don't need a dependency for a pretty CLI. */
export const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
} as const;

export function paint(code: string, text: string): string {
  return `${code}${text}${c.reset}`;
}

export const dim = (s: string) => paint(c.gray, s);
export const bold = (s: string) => paint(c.bold, s);
export const red = (s: string) => paint(c.red, s);
export const green = (s: string) => paint(c.green, s);
export const yellow = (s: string) => paint(c.yellow, s);
export const cyan = (s: string) => paint(c.cyan, s);
export const magenta = (s: string) => paint(c.magenta, s);

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

/** Truncate long output for the live turn trace. */
export function truncate(s: string, n: number): string {
  const flat = s.replaceAll("\n", " ").replaceAll(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n) + "…" : flat;
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

export function isTruthy(v: string | undefined): boolean {
  if (v === undefined) return false;
  return !["", "0", "false", "no", "off"].includes(v.toLowerCase());
}

/** Robust JSON parse for model output (tolerates leading/trailing noise). */
export function parseJsonArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Models love to wrap args in ```json fences or prose. Find the first
    // balanced object instead of giving up.
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        /* fall through */
      }
    }
    return {};
  }
}

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

/** Resolve a path against the workspace root and reject escapes. */
export function confine(root: string, p: string): string {
  const abs = path.resolve(root, p);
  const rel = path.relative(path.resolve(root), abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${p}`);
  }
  return abs;
}

/** True if a command matches any allowlist entry (prefix or exact). */
export function matchesAllowlist(cmd: string, allow: string[]): boolean {
  const trimmed = cmd.trim();
  return allow.some((entry) => {
    const e = entry.trim();
    if (e === "") return false;
    return trimmed === e || trimmed.startsWith(e + " ");
  });
}

/** Rough USD cost for a token count, or null when unknown. */
export function costUsd(
  model: string,
  input: number,
  output: number,
): number | null {
  // $/1M tokens for a few common families. Unknown models → null.
  const table: Array<[RegExp, number, number]> = [
    [/gpt-4o/i, 2.5, 10],
    [/gpt-4.1/i, 2, 8],
    [/gpt-4/i, 30, 60],
    [/o1|o3/i, 15, 60],
    [/claude-3-5|claude-3-7/i, 3, 15],
    [/claude-4/i, 3, 15],
    [/claude-3-5-haiku/i, 0.8, 4],
    [/claude-3-haiku/i, 0.25, 1.25],
    [/deepseek/i, 0.27, 1.1],
    [/qwen/i, 0.4, 1.6],
    [/llama/i, 0.3, 0.6],
    [/gemini/i, 1.25, 5],
  ];
  for (const [re, iRate, oRate] of table) {
    if (re.test(model)) {
      return (input / 1e6) * iRate + (output / 1e6) * oRate;
    }
  }
  return null;
}

export function fmtTokens(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Read a file, or undefined. */
export function readFileOr(p: string): string | undefined {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
}

/** Parse a Server-Sent-Events response body, calling onEvent per `data:` line. */
export async function sseEvents(
  resp: globalThis.Response,
  onEvent: (data: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!resp.body) return;
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    if (signal?.aborted) break;
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE frames are separated by blank lines; some servers send one per line.
    const parts = buf.split(/\r?\n\r?\n/);
    buf = parts.pop() ?? "";
    for (const frame of parts) {
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith("data:")) {
          onEvent(line.slice(5).trim());
        }
      }
    }
  }
}

export function loadEnvFile(p: string): void {
  const raw = readFileOr(p);
  if (!raw) return;
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

/** Statuses worth retrying: rate limits, transient 5xx, and network drops. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

/** A thrown error that carries an HTTP status is retried when the status says so. */
export class RetryableError extends Error {
  readonly retryAfterMs: number | undefined;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "RetryableError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds. */
export function retryAfterMs(resp: Response): number | undefined {
  const h = resp.headers?.get?.("retry-after");
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(h);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `fn`, retrying transient failures with exponential backoff + jitter.
 * `fn` throws a RetryableError for anything worth retrying; a plain Error
 * fails fast. Aborts (AbortError) always propagate immediately. Honors a
 * Retry-After hint when present. Max attempts default 3.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number; maxMs?: number; signal?: AbortSignal; onRetry?: (err: unknown, waitMs: number) => void } = {},
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const baseMs = opts.baseMs ?? 500;
  const maxMs = opts.maxMs ?? 8000;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (opts.signal?.aborted) throw new Error("aborted");
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (opts.signal?.aborted) throw err;
      if ((err as Error).name === "AbortError") throw err;
      const transient = err instanceof RetryableError;
      if (!transient || attempt === attempts) throw err;
      // Exponential backoff with ±20% jitter, capped, honoring Retry-After.
      const exp = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const hinted = transient && (err as RetryableError).retryAfterMs;
      const raw = hinted && hinted > 0 ? hinted : exp;
      const wait = Math.min(maxMs, Math.round(raw * (0.8 + Math.random() * 0.4)));
      opts.onRetry?.(err, wait);
      await sleep(wait);
    }
  }
  throw lastErr;
}
