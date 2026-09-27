// providers/router.ts — the OmniRoute-style layer. One Provider fronting
// many backends (each a Provider with its own endpoint, model, and API key).
// Strategies:
//   failover   — try backends in order, skip recently-failed ones (circuit
//                breaker), report the first success. Great for gateways and
//                key rotation: backend B is the same endpoint with a spare key.
//   roundrobin — alternate across backends to spread load.
//   weighted   — pick by configured weights.
//
// A failed call marks the backend down for a cooldown; successes heal it.
// Backends can carry a BUDGET (a max-calls / max-tokens / max-USD ceiling):
// spent backends drop to the end of the pick order, so cheap/free backends
// serve until they exhaust their quota before paid ones are touched.
// The router surfaces per-backend status so `claw /backends` can show you
// exactly which model/key answered what.

import type { ChatMsg, Provider, ProviderResult, ToolDef } from "../types.ts";
import { costUsd, dim } from "../util.ts";

export type RouteStrategy = "failover" | "roundrobin" | "weighted";

/** A per-backend spending ceiling. A backend that crosses ANY limit is
 * considered spent and skipped until (and unless) everything else is too. */
export interface BackendBudget {
  /** Max successful calls served by this backend. */
  maxCalls?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  /** Max estimated USD spend (uses the same price table as the ledger). */
  maxUsd?: number;
}

export interface BackendStatus {
  label: string;
  provider: Provider;
  ok: boolean;
  calls: number;
  errors: number;
  lastError?: string;
  lastErrorAt?: number;
  budget?: BackendBudget;
  /** Usage accrued against the budget. */
  spent: { calls: number; inputTokens: number; outputTokens: number; usd: number };
}

const COOLDOWN_MS = 30_000;

export class RouterProvider implements Provider {
  readonly streamable = true;
  readonly name = "router";
  statuses: BackendStatus[] = [];
  private cursor = 0;
  private strategy: RouteStrategy;
  private weights: number[];

  constructor(
    providers: Provider[],
    strategy: RouteStrategy = "failover",
    weights: number[] = [],
    budgets: Array<BackendBudget | undefined> = [],
  ) {
    this.strategy = strategy;
    this.statuses = providers.map((p, i) => ({
      label: `${p.name} / ${p.model}`,
      provider: p,
      ok: true,
      calls: 0,
      errors: 0,
      budget: budgets[i],
      spent: { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 },
    }));
    this.weights =
      weights.length === providers.length ? weights : providers.map(() => 1);
  }

  strategyLabel(): string {
    return this.strategy;
  }

  /** The model we'd report to the cost ledger and prompt: last healthy backend. */
  get model(): string {
    const active = this.statuses.find((s) => s.ok) ?? this.statuses[0];
    return active ? active.provider.model : "?";
  }

  /** True once the backend has crossed any configured budget limit. */
  private exhausted(st: BackendStatus): boolean {
    const b = st.budget;
    if (!b) return false;
    if (b.maxCalls !== undefined && st.spent.calls >= b.maxCalls) return true;
    if (b.maxInputTokens !== undefined && st.spent.inputTokens >= b.maxInputTokens) return true;
    if (b.maxOutputTokens !== undefined && st.spent.outputTokens >= b.maxOutputTokens) return true;
    if (b.maxUsd !== undefined && st.spent.usd >= b.maxUsd) return true;
    return false;
  }

  async chat(
    messages: ChatMsg[],
    tools: ToolDef[],
    opts?: { onText?: (d: string) => void; signal?: AbortSignal },
  ): Promise<ProviderResult> {
    const order = this.pickOrder();
    let lastErr: Error | undefined;

    for (const idx of order) {
      const st = this.statuses[idx];
      st.calls++;
      try {
        const result = await st.provider.chat(messages, tools, opts);
        st.ok = true;
        st.lastError = undefined;
        st.lastErrorAt = undefined;
        // Accrue usage against the backend's budget (if it has one).
        if (st.budget && result.usage) {
          st.spent.calls++;
          st.spent.inputTokens += result.usage.inputTokens ?? 0;
          st.spent.outputTokens += result.usage.outputTokens ?? 0;
          st.spent.usd += costUsd(st.provider.model, result.usage.inputTokens ?? 0, result.usage.outputTokens ?? 0) ?? 0;
        }
        return result;
      } catch (err) {
        st.ok = false;
        st.errors++;
        st.lastError = (err as Error).message;
        st.lastErrorAt = Date.now();
        lastErr = err as Error;
        // Fall through to the next backend (or next key, if the user
        // configured multiple).
      }
    }
    throw lastErr ?? new Error("all backends failed");
  }

  /** Healthy backends first (failover), or strategy order. Spent backends
   * sink to the end so budgets are respected before all else fails. */
  private pickOrder(): number[] {
    const n = this.statuses.length;
    if (n === 0) return [];
    const now = Date.now();
    const spentness = (i: number) => (this.exhausted(this.statuses[i]) ? 1 : 0);
    const downness = (i: number) => {
      const at = this.statuses[i].lastErrorAt;
      return at !== undefined && now - at < COOLDOWN_MS ? 1 : 0;
    };

    let base: number[];
    if (this.strategy === "roundrobin") {
      const start = (this.cursor++ % n + n) % n;
      base = Array.from({ length: n }, (_, i) => (start + i) % n);
    } else if (this.strategy === "weighted") {
      const remaining = this.statuses.map((_, i) => i);
      base = [];
      while (remaining.length) {
        const total = remaining.reduce((a, i) => a + this.weights[i], 0);
        let r = Math.random() * total;
        let pick = remaining[0];
        for (const i of remaining) {
          r -= this.weights[i];
          if (r <= 0) {
            pick = i;
            break;
          }
        }
        base.push(pick);
        remaining.splice(remaining.indexOf(pick), 1);
      }
    } else {
      // failover: healthy (or cooled-down) backends first, in config order.
      base = this.statuses.map((_, i) => i).sort((a, b) => downness(a) - downness(b));
    }
    // Strategy order wins inside each tier; spent backends move behind fresh ones.
    return base.sort((a, b) => spentness(a) - spentness(b));
  }

  /** One-line status table for /backends. */
  report(): string[] {
    return this.statuses.map((s) => {
      const state = s.ok ? "✓" : "✗";
      const err = s.lastError ? ` — ${truncate(s.lastError, 60)}` : "";
      const budget = s.budget
        ? ` · budget ${describeSpent(s)}${this.exhausted(s) ? " SPENT" : ""}`
        : "";
      return `  ${state} ${s.label}  ${dim(`(${s.calls} calls, ${s.errors} err)${budget}${err}`)}`;
    });
  }
}

function describeSpent(st: BackendStatus): string {
  const b = st.budget!;
  const parts: string[] = [];
  if (b.maxCalls !== undefined) parts.push(`${st.spent.calls}/${b.maxCalls} calls`);
  if (b.maxInputTokens !== undefined) parts.push(`${st.spent.inputTokens}/${b.maxInputTokens} in`);
  if (b.maxOutputTokens !== undefined) parts.push(`${st.spent.outputTokens}/${b.maxOutputTokens} out`);
  if (b.maxUsd !== undefined) parts.push(`$${st.spent.usd.toFixed(4)}/$${b.maxUsd}`);
  return parts.join(", ");
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
