// providers/mock.ts — a scripted "LLM" so CLAW runs with zero setup.
//
// It pattern-matches the user's request and emits tool calls, then a final
// answer — exactly the shape a real model returns, so the agent loop below is
// identical either way. This is the same trick as claw-orchestrator's mock.

import type { ChatMsg, Provider, ProviderResult, ToolCall } from "../types.ts";
import { newId } from "../util.ts";

export class MockProvider implements Provider {
  readonly streamable = true;
  readonly name = "mock (scripted)";
  readonly model: string;

  constructor(model = "mock-1") {
    this.model = model;
  }

  async chat(
    messages: ChatMsg[],
    _tools: unknown[],
    opts?: { onText?: (d: string) => void },
  ): Promise<ProviderResult> {
    // Find the latest non-system user message.
    let user = "";
    for (const m of messages) {
      if (m.role === "user") user = m.content.toLowerCase();
    }

    // If the last message is a tool result, answer with text.
    const last = messages[messages.length - 1];
    if (last.role === "tool") {
      const text = `Done — the tool returned:\n\n${last.content.slice(0, 500)}`;
      opts?.onText?.(text);
      return { content: text, toolCalls: [], usage: { inputTokens: 10, outputTokens: 20 } };
    }

    let toolCalls: ToolCall[] = [];
    let content = "";

    const call = (name: string, args: Record<string, unknown>): ToolCall[] => [
      { id: newId("call"), type: "function", function: { name, arguments: JSON.stringify(args) } },
    ];

    // Compaction asks the model to summarize a conversation excerpt.
    if (/^summarize this excerpt/i.test(user)) {
      content = "[mock summary] The user worked with the agent on tasks involving its workspace files and tools; no unresolved decisions remain.";
      opts?.onText?.(content);
      return { content, toolCalls: [], usage: { inputTokens: 100, outputTokens: 30 } };
    }
    if (/\bcalc\b|[\d\s][+\-*/][\d\s]/.test(user)) {
      const m = user.match(/(\d+)\s*([+\-*/])\s*(\d+)/);
      if (m) {
        toolCalls = call("calc", { expr: `${m[1]} ${m[2]} ${m[3]}` });
      } else {
        toolCalls = call("calc", { expr: "12 * 9" });
      }
    } else if (/(^|\s)(date|time)\b/.test(user)) {
      toolCalls = call("shell", { cmd: "date" });
    } else if (/who am i|whoami|user\b/.test(user)) {
      toolCalls = call("shell", { cmd: "whoami" });
    } else if (/list|ls\b|what.*(files|here)/.test(user)) {
      toolCalls = call("list_dir", { path: "." });
    } else if (/parallel/.test(user)) {
      // Demo the parallel fan-out: two independent sub-agents at once.
      toolCalls = call("delegate", { tasks: ["compute 7 * 6", "list the files here"] });
    } else if (/build|portfolio|website/.test(user)) {
      toolCalls = call("write_file", {
        path: "portfolio/index.html",
        content:
          "<!doctype html><html><head><title>My Portfolio</title></head><body><h1>Hello!</h1><p>Built by CLAW.</p></body></html>",
      });
    } else if (/(^|\s)hello\b|^hi\b|hey/.test(user)) {
      content = "Hello! I'm CLAW. Try: 'calc 7 * 6', 'what is the date', 'who am i', 'list files', or 'build me a portfolio website'. (This is the scripted mock — run `claw init` or set CLAW_API_KEY for a real model.)";
    } else {
      content = "I can 'calc 7 * 6', tell you the date, say 'who am i', 'list files', or 'build a website'. (This is the scripted mock — run `claw init` or set CLAW_API_KEY to connect a real model.)";
    }

    if (toolCalls.length === 0 && content) {
      opts?.onText?.(content);
    }
    return {
      content,
      toolCalls,
      usage: { inputTokens: 25, outputTokens: toolCalls.length ? 15 : 30 },
    };
  }
}
