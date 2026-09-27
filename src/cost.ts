// cost.ts — a session ledger that accrues real token usage so we can price
// the work, exactly like claw-orchestrator's ledger.

import type { Usage } from "./types.ts";
import { costUsd, fmtTokens } from "./util.ts";

export class Ledger {
  private input = 0;
  private output = 0;
  private cacheRead = 0;
  private cacheWrite = 0;
  private calls = 0;

  add(u: Usage | null | undefined): void {
    if (!u) return;
    this.input += u.inputTokens ?? 0;
    this.output += u.outputTokens ?? 0;
    this.cacheRead += u.cacheReadTokens ?? 0;
    this.cacheWrite += u.cacheWriteTokens ?? 0;
    this.calls++;
  }

  merge(other: Ledger): void {
    this.input += other.input;
    this.output += other.output;
    this.cacheRead += other.cacheRead;
    this.cacheWrite += other.cacheWrite;
    this.calls += other.calls;
  }

  get totals(): { input: number; output: number; cacheRead: number; cacheWrite: number; calls: number } {
    return {
      input: this.input,
      output: this.output,
      cacheRead: this.cacheRead,
      cacheWrite: this.cacheWrite,
      calls: this.calls,
    };
  }

  /** One-line summary, e.g. "in 2.1k · out 1.4k · cache 512 · 3 calls · $0.008". */
  report(model: string): string {
    const t = this.totals;
    const usd = costUsd(model, t.input, t.output);
    const parts = [
      `in ${fmtTokens(t.input)}`,
      `out ${fmtTokens(t.output)}`,
      t.cacheRead ? `cached ${fmtTokens(t.cacheRead)}` : "",
      `${t.calls} call${t.calls === 1 ? "" : "s"}`,
    ].filter(Boolean);
    if (usd !== null) parts.push(`$${usd.toFixed(4)}`);
    return parts.join(" · ");
  }
}
