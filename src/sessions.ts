// sessions.ts — persist conversations as JSONL so `claw --continue` can
// resume yesterday's work, and keep a prompt history file for arrow-key
// recall in the REPL.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatMsg } from "./types.ts";
import { ensureDir, newId, nowIso } from "./util.ts";

export interface SessionMeta {
  id: string;
  createdAt: string;
  model: string;
  baseURL: string;
  workspace: string;
  turns: number;
  /** Human-readable title, derived from the first message. */
  title?: string;
  /** Optional LLM summary written when the session was closed. */
  summary?: string;
}

export class SessionStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.jsonl`);
  }

  /** List sessions, newest first. */
  list(): SessionMeta[] {
    ensureDir(this.dir);
    const out: SessionMeta[] = [];
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const meta = this.readMeta(path.join(this.dir, f));
      if (meta) out.push(meta);
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  latest(): SessionMeta | null {
    return this.list()[0] ?? null;
  }

  /** The metadata header of one session (null if missing/corrupt). */
  meta(id: string): SessionMeta | null {
    return this.readMeta(this.file(id));
  }

  /** Patch the metadata header (e.g. store a summary-on-close). */
  updateMeta(id: string, patch: Partial<SessionMeta>): SessionMeta | null {
    const file = this.file(id);
    const lines = fs.readFileSync(file, "utf8").split("\n");
    if (!lines[0]) return null;
    try {
      const meta = { ...(JSON.parse(lines[0]) as SessionMeta), ...patch };
      lines[0] = JSON.stringify(meta);
      fs.writeFileSync(file, lines.join("\n"));
      return meta;
    } catch {
      return null;
    }
  }

  private readMeta(file: string): SessionMeta | null {
    try {
      const first = fs.readFileSync(file, "utf8").split("\n")[0];
      return JSON.parse(first) as SessionMeta;
    } catch {
      return null;
    }
  }

  create(model: string, baseURL: string, workspace: string): { id: string; meta: SessionMeta } {
    ensureDir(this.dir);
    const id = newId("sess");
    const meta: SessionMeta = {
      id,
      createdAt: nowIso(),
      model,
      baseURL,
      workspace,
      turns: 0,
    };
    fs.appendFileSync(this.file(id), JSON.stringify(meta) + "\n");
    return { id, meta };
  }

  append(id: string, msg: ChatMsg): void {
    fs.appendFileSync(this.file(id), JSON.stringify(msg) + "\n");
  }

  /**
   * Append an arbitrary record (tool-trace events, reasoning blobs). The
   * session log is the single artifact the trajectory view replays from —
   * the DeepSeek Harness invariant: if the model saw it or did it, it's a
   * line in this file.
   */
  appendRaw(id: string, record: Record<string, unknown>): void {
    const json = JSON.stringify({ type: "event", ...record });
    fs.appendFileSync(this.file(id), json + "\n");
  }

  /** Every record of a session in order: messages AND events. */
  loadRaw(id: string): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    try {
      const lines = fs.readFileSync(this.file(id), "utf8").split("\n").filter(Boolean);
      for (let i = 1; i < lines.length; i++) {
        try {
          out.push(JSON.parse(lines[i]) as Record<string, unknown>);
        } catch {
          /* skip corrupt line */
        }
      }
    } catch {
      /* no such session */
    }
    return out;
  }

  /** Raw file text — the session-search index scans this. */
  rawText(id: string): string {
    try {
      return fs.readFileSync(this.file(id), "utf8");
    } catch {
      return "";
    }
  }

  /** Re-read the full conversation (minus the header line). */
  load(id: string): ChatMsg[] {
    const raw = fs.readFileSync(this.file(id), "utf8").split("\n").filter(Boolean);
    const out: ChatMsg[] = [];
    for (let i = 1; i < raw.length; i++) {
      try {
        out.push(JSON.parse(raw[i]) as ChatMsg);
      } catch {
        /* skip corrupt line */
      }
    }
    return out;
  }

  bumpTurns(id: string, n: number): void {
    const file = this.file(id);
    const lines = fs.readFileSync(file, "utf8").split("\n");
    if (!lines[0]) return;
    try {
      const meta = JSON.parse(lines[0]) as SessionMeta;
      meta.turns = n;
      lines[0] = JSON.stringify(meta);
      fs.writeFileSync(file, lines.join("\n"));
    } catch {
      /* ignore */
    }
  }
}

/** Load previously-typed prompts into readline's history. */
export function loadHistoryFile(p: string, max: number): string[] {
  try {
    const raw = fs.readFileSync(p, "utf8");
    return raw.split("\n").filter(Boolean).slice(-max);
  } catch {
    return [];
  }
}

export function appendHistoryFile(p: string, line: string): void {
  try {
    ensureDir(path.dirname(p));
    fs.appendFileSync(p, line + "\n");
  } catch {
    /* non-fatal */
  }
}
