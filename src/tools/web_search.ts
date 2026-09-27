// tools/web_search.ts — live web search. Backends, in order of preference:
//   1. TINYFISH_API_KEY → api.search.tinyfish.ai (free tier, no key needed
//      via the MCP server either)
//   2. TAVILY_API_KEY    → api.tavily.com
//   3. BRAVE_API_KEY     → api.search.brave.com
//   4. nothing set       → DuckDuckGo HTML (keyless, best effort)
//
// The DuckDuckGo parser is exported as a pure function so the selfcheck can
// pin it down without the network.

import type { Tool } from "../types.ts";

const MAX_RESULTS = 8;
const TIMEOUT_MS = 12_000;

export function makeWebSearchTool(provider: string): Tool {
  return {
    name: "web_search",
    description:
      "Search the web and return ranked results with titles, URLs, and snippets. Use for research, docs, current events, and finding sources — then fetch pages with web_fetch.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        max_results: { type: "number", description: `How many results (default ${MAX_RESULTS}).` },
      },
      required: ["query"],
    },
    risk: "read",
    cacheable: false,
    async execute(args) {
      const query = String(args.query ?? "").trim();
      if (!query) throw new Error("query is required");
      const max = Math.min(Number(args.max_results ?? MAX_RESULTS) || MAX_RESULTS, 10);
      return await searchWeb(query, max, provider);
    },
  };
}

export async function searchWeb(query: string, max: number, provider: string): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const effective = provider === "auto" ? pickProvider() : provider;
    switch (effective) {
      case "tinyfish": {
        const key = process.env.TINYFISH_API_KEY;
        if (!key) return duckDuckGo(query, max, ac);
        const resp = await fetch(
          `https://api.search.tinyfish.ai?query=${encodeURIComponent(query)}&count=${max}`,
          { headers: { "x-api-key": key }, signal: ac.signal },
        );
        if (!resp.ok) return `tinyfish: HTTP ${resp.status}`;
        const json = (await resp.json()) as Record<string, unknown>;
        return formatGenericResults("tinyfish", json, max);
      }
      case "tavily": {
        const key = process.env.TAVILY_API_KEY;
        if (!key) return duckDuckGo(query, max, ac);
        const resp = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ api_key: key, query, max_results: max, search_depth: "basic" }),
          signal: ac.signal,
        });
        if (!resp.ok) return `tavily: HTTP ${resp.status}`;
        const json = (await resp.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
        return (json.results ?? [])
          .slice(0, max)
          .map((r, i) => `${i + 1}. ${r.title ?? "(no title)"}\n   ${r.url ?? ""}\n   ${(r.content ?? "").slice(0, 250)}`)
          .join("\n\n") || "(no results)";
      }
      case "brave": {
        const key = process.env.BRAVE_API_KEY;
        if (!key) return duckDuckGo(query, max, ac);
        const resp = await fetch(
          `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${max}`,
          { headers: { "x-subscription-token": key }, signal: ac.signal },
        );
        if (!resp.ok) return `brave: HTTP ${resp.status}`;
        const json = (await resp.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
        return (json.web?.results ?? [])
          .slice(0, max)
          .map((r, i) => `${i + 1}. ${r.title ?? "(no title)"}\n   ${r.url ?? ""}\n   ${(r.description ?? "").slice(0, 250)}`)
          .join("\n\n") || "(no results)";
      }
      case "duckduckgo":
      default:
        return await duckDuckGo(query, max, ac);
    }
  } finally {
    clearTimeout(timer);
  }
}

function pickProvider(): string {
  if (process.env.TINYFISH_API_KEY) return "tinyfish";
  if (process.env.TAVILY_API_KEY) return "tavily";
  if (process.env.BRAVE_API_KEY) return "brave";
  return "duckduckgo";
}

/** DuckDuckGo HTML scraping — keyless, best effort. Returns formatted text. */
async function duckDuckGo(query: string, max: number, ac: AbortController): Promise<string> {
  const resp = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; claw-agent/0.1)" },
    signal: ac.signal,
  });
  if (!resp.ok) return `duckduckgo: HTTP ${resp.status}`;
  const html = await resp.text();
  const results = parseDuckDuckGo(html).slice(0, max);
  if (!results.length) return "(no results — duckduckgo may be rate-limiting; set TINYFISH_API_KEY or TAVILY_API_KEY for a proper backend)";
  return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Pure HTML parser — exported for the selfcheck. */
export function parseDuckDuckGo(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const links: Array<{ href: string; title: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html))) {
    links.push({ href: decode(m[1]), title: stripTags(decode(m[2])) });
  }
  const snippets: string[] = [];
  while ((m = snipRe.exec(html))) snippets.push(stripTags(decode(m[1])));
  for (let i = 0; i < links.length; i++) {
    out.push({ title: links[i].title, url: links[i].href, snippet: snippets[i] ?? "" });
  }
  return out;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'");
}

/** Best-effort formatter for providers with unknown JSON shapes. */
function formatGenericResults(provider: string, json: Record<string, unknown>, max: number): string {
  const arr = (json.results ?? json.data ?? []) as Array<Record<string, unknown>>;
  if (!Array.isArray(arr) || !arr.length) {
    const text = JSON.stringify(json).slice(0, 300);
    return `(${provider}: unexpected response ${text})`;
  }
  return arr
    .slice(0, max)
    .map((r, i) => {
      const title = String(r.title ?? r.name ?? "(no title)");
      const url = String(r.url ?? r.link ?? "");
      const snip = String(r.content ?? r.snippet ?? r.description ?? "");
      return `${i + 1}. ${title}\n   ${url}\n   ${snip.slice(0, 250)}`;
    })
    .join("\n\n");
}
