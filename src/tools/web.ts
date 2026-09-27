// tools/web.ts — read-only web fetch. Gives the agent the ability to look at
// documentation and URLs ("all of them combined" — chat, code, and the web).
// Restricted to http(s) and capped in size. Output is secret-scanned like
// every other tool.

import type { Tool } from "../types.ts";

const MAX_PAGE = 20_000;
const TIMEOUT_MS = 15_000;

export function makeWebTool(): Tool {
  return {
    name: "web_fetch",
    description:
      "Fetch a URL (http/https only) and return its text content. Useful for reading docs, checking APIs, or verifying a page. Read-only.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "The http(s) URL to fetch." } },
      required: ["url"],
    },
    risk: "read",
    cacheable: false,
    async execute(args) {
      const url = String(args.url ?? "");
      if (!/^https?:\/\//i.test(url)) {
        throw new Error("only http(s) URLs are allowed");
      }
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
      try {
        const resp = await fetch(url, {
          signal: ac.signal,
          headers: { "user-agent": "claw-terminal-agent/0.1" },
          redirect: "follow",
        });
        if (!resp.ok) return `HTTP ${resp.status} ${resp.statusText}`;
        let text = await resp.text();
        // Strip HTML tags crudely so the model gets readable text.
        text = text
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        if (text.length > MAX_PAGE) text = text.slice(0, MAX_PAGE) + "\n…[truncated]";
        return text || "(empty page)";
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
