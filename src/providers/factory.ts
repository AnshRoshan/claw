// providers/factory.ts — turn config into Providers. Handles:
//   - the default single backend (baseURL/model/apiKey, as before)
//   - model aliases: `models.<alias>` → one backend or a RouterProvider
//   - multi-key backends: `keys` rotate on auth failure (each key becomes a
//     failover variant of the same endpoint)
//   - the no-key fallback decision (mock) — kept here so `claw models` and
//     the REPL agree with the CLI about what would actually be used.

import type { Provider } from "../types.ts";
import type { ClawConfig, ModelAliasSpec, ModelBackendSpec } from "../config.ts";
import { OpenAIProvider } from "./openai.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { MockProvider } from "./mock.ts";
import { RouterProvider, type BackendBudget, type RouteStrategy } from "./router.ts";

export interface BackendBuildOpts {
  baseURL: string;
  defaultModel: string;
  /** Default apiKey — an env var name or a literal key. */
  defaultKey: string;
  anthropic: boolean;
}

/**
 * Resolve a key value. `raw` is either the name of an env var (the default,
 * OMNIROUTE_API_KEY), a literal key, or undefined → falls back to defaultKey.
 * Returns undefined when the named env var is unset.
 */
export function resolveKey(raw: string | undefined, defaultKey: string): string | undefined {
  const r = raw ?? defaultKey;
  if (!r) return undefined;
  if (r in process.env) return process.env[r];
  if (r === defaultKey) return undefined; // the unset default env name
  return r; // a literal key
}

export function buildBackend(spec: ModelBackendSpec, opts: BackendBuildOpts): Provider {
  const model = spec.model ?? opts.defaultModel;
  const type = spec.type ?? (opts.anthropic ? "anthropic" : "openai");
  switch (type) {
    case "mock":
      return new MockProvider(model);
    case "anthropic": {
      const k = resolveKey(spec.apiKey, opts.defaultKey) ?? process.env.ANTHROPIC_API_KEY;
      if (!k) throw new Error(`anthropic backend "${model}" needs an API key`);
      return new AnthropicProvider(k, model);
    }
    default:
      return new OpenAIProvider(spec.baseURL ?? opts.baseURL, resolveKey(spec.apiKey, opts.defaultKey), model);
  }
}

/**
 * Build the provider for a model name or alias:
 *   - a configured alias with 1 backend → that backend
 *   - an alias with N backends → RouterProvider (failover/roundrobin/weighted)
 *   - anything else → a single backend using `name` as the model
 * A backend with `keys: [A, B]` becomes two failover variants of the same
 * endpoint — auth failures rotate through them automatically.
 */
export function buildModelProvider(name: string, models: Record<string, ModelAliasSpec>, opts: BackendBuildOpts): Provider {
  const alias = models[name];
  if (!alias) {
    return buildBackend({ model: name }, opts);
  }
  return buildRouter(alias, opts);
}

export function buildRouter(alias: ModelAliasSpec, opts: BackendBuildOpts): Provider {
  const providers: Provider[] = [];
  const weights: number[] = [];
  const budgets: Array<BackendBudget | undefined> = [];
  const failures: string[] = [];

  for (const b of alias.backends) {
    const keys = b.keys && b.keys.length ? b.keys : [b.apiKey];
    for (const k of keys) {
      try {
        providers.push(buildBackend({ ...b, apiKey: k }, opts));
        weights.push(b.weight ?? 1);
        budgets.push(b.budget);
      } catch (err) {
        failures.push((err as Error).message);
      }
    }
  }

  if (providers.length === 0) {
    throw new Error(`model alias "${alias.strategy ?? "?"}" has no usable backends${failures.length ? ": " + failures.join("; ") : ""}`);
  }
  if (providers.length === 1) return providers[0];
  return new RouterProvider(providers, alias.strategy ?? "failover", weights, budgets);
}

/** True if the default config or any configured backend resolves a key. */
export function anyKeyConfigured(config: ClawConfig): boolean {
  if (resolveKey(config.apiKey, config.apiKey) !== undefined) return true;
  for (const alias of Object.values(config.models)) {
    for (const b of alias.backends) {
      const keys = b.keys && b.keys.length ? b.keys : [b.apiKey];
      for (const k of keys) {
        if (resolveKey(k, config.apiKey) !== undefined) return true;
      }
    }
  }
  return false;
}

/** Describe an alias for `claw models` and `/models`. */
export function describeAlias(name: string, alias: ModelAliasSpec, opts: BackendBuildOpts): string[] {
  const strategy: RouteStrategy = alias.strategy ?? "failover";
  const lines: string[] = [];
  if (Object.keys(alias.backends).length === 0) {
    return [`  ${name}  (no backends configured)`];
  }
  lines.push(`  ${name}  [${strategy}]`);
  for (const b of alias.backends) {
    const keys = b.keys && b.keys.length ? b.keys : [b.apiKey];
    for (const k of keys) {
      const keyState = resolveKey(k, opts.defaultKey) ? "key ✓" : "key ✗ (unset)";
      const type = b.type ?? (opts.anthropic ? "anthropic" : "openai");
      const budget = b.budget
        ? `  budget: ${[b.budget.maxCalls !== undefined ? `${b.budget.maxCalls} calls` : null, b.budget.maxUsd !== undefined ? `$${b.budget.maxUsd}` : null, b.budget.maxInputTokens !== undefined ? `${b.budget.maxInputTokens} in` : null, b.budget.maxOutputTokens !== undefined ? `${b.budget.maxOutputTokens} out` : null].filter(Boolean).join(", ")}`
        : "";
      lines.push(`    • ${b.model ?? opts.defaultModel}  ${type}${b.baseURL ? " " + b.baseURL : ""}  (${keyState})${budget}`);
    }
  }
  return lines;
}
