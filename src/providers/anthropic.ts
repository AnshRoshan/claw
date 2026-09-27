// providers/anthropic.ts — Anthropic Messages API adapter with streaming.
//
// Translates our canonical OpenAI-style messages to the Anthropic shape and
// back. Tool calls: the model returns tool_use blocks; we synthesize our own
// call ids and echo them with tool_result blocks. Exactly the same pattern as
// claw-orchestrator's anthropicProvider, but with real streaming + usage.

import type { ChatMsg, Provider, ProviderResult, ToolCall, ToolDef, Usage } from "../types.ts";
import { isRetryableStatus, newId, parseJsonArgs, retryAfterMs, RetryableError, sseEvents, withRetry } from "../util.ts";

const API = "https://api.anthropic.com/v1/messages";
const VERSION = "2023-06-01";
const MAX_TOKENS = 4096;

interface AContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  partial_json?: string;
}

interface AEvent {
  type: string;
  message?: {
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  };
  content_block?: { type: string; id?: string; name?: string; input?: Record<string, unknown> };
  delta?: { type?: string; text?: string; partial_json?: string };
  index?: number;
  usage?: { output_tokens?: number };
}

export class AnthropicProvider implements Provider {
  readonly streamable = true;
  readonly name = "anthropic";
  readonly apiKey: string;
  readonly model: string;
  /** Overridable for tests; defaults to the real API. */
  readonly endpoint: string;

  constructor(apiKey: string, model: string, endpoint: string = API) {
    this.apiKey = apiKey;
    this.model = model;
    this.endpoint = endpoint;
  }

  async chat(
    messages: ChatMsg[],
    tools: ToolDef[],
    opts?: { onText?: (d: string) => void; signal?: AbortSignal },
  ): Promise<ProviderResult> {
    const { system, apiMsgs } = toAnthropic(messages);

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: MAX_TOKENS,
      system,
      messages: apiMsgs,
      tools,
      stream: true,
    };

    const resp = await withRetry(
      async () => {
        let r: Response;
        try {
          r = await fetch(this.endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": this.apiKey,
              "anthropic-version": VERSION,
            },
            body: JSON.stringify(body),
            signal: opts?.signal,
          });
        } catch (err) {
          if ((err as Error).name === "AbortError") throw err;
          throw new RetryableError(`network error contacting anthropic: ${(err as Error).message}`);
        }
        if (!r.ok) {
          const detail = (await r.text().catch(() => "")).slice(0, 300);
          const msg = `HTTP ${r.status} from anthropic: ${detail || r.statusText}`;
          if (isRetryableStatus(r.status)) throw new RetryableError(msg, retryAfterMs(r));
          throw new Error(msg);
        }
        return r;
      },
      { signal: opts?.signal },
    );

    // Accumulate blocks. Tool-use args arrive as partial_json deltas.
    const blocks: AContentBlock[] = [];
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };

    await sseEvents(
      resp,
      (data) => {
        if (!data || data === "[DONE]") return;
        let ev: AEvent;
        try {
          ev = JSON.parse(data) as AEvent;
        } catch {
          return;
        }
        switch (ev.type) {
          case "message_start":
            if (ev.message?.usage) {
              usage = {
                inputTokens: ev.message.usage.input_tokens ?? 0,
                outputTokens: ev.message.usage.output_tokens ?? 0,
                cacheReadTokens: ev.message.usage.cache_read_input_tokens,
                cacheWriteTokens: ev.message.usage.cache_creation_input_tokens,
              };
            }
            break;
          case "content_block_start":
            if (ev.content_block?.type === "tool_use") {
              blocks[ev.index ?? blocks.length] = {
                type: "tool_use",
                id: ev.content_block.id ?? newId("tu"),
                name: ev.content_block.name,
                input: ev.content_block.input ?? {},
              };
            } else if (ev.content_block?.type === "text") {
              blocks[ev.index ?? blocks.length] = { type: "text", text: "" };
            }
            break;
          case "content_block_delta":
            if (ev.delta?.type === "text_delta" && ev.delta.text) {
              const b = blocks[ev.index ?? blocks.length];
              if (b && b.type === "text") {
                b.text = (b.text ?? "") + ev.delta.text;
                opts?.onText?.(ev.delta.text);
              }
            } else if (ev.delta?.type === "input_json_delta" && ev.delta.partial_json) {
              const b = blocks[ev.index ?? blocks.length];
              if (b && b.type === "tool_use") {
                b.partial_json = (b.partial_json ?? "") + ev.delta.partial_json;
              }
            }
            break;
          case "message_delta":
            if (ev.usage?.output_tokens) usage.outputTokens = ev.usage.output_tokens;
            break;
        }
      },
      opts?.signal,
    );

    let content = "";
    const toolCalls: ToolCall[] = [];
    for (const b of blocks) {
      if (b.type === "text") content += b.text ?? "";
      if (b.type === "tool_use" && b.id && b.name) {
        const raw = b.partial_json ?? (b.input ? JSON.stringify(b.input) : "{}");
        toolCalls.push({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: raw || "{}" },
        });
      }
    }

    return { content, toolCalls, usage: usage.inputTokens || usage.outputTokens ? usage : null };
  }
}

/**
 * Convert our canonical messages to Anthropic's shape. System prompts go to
 * the top-level `system` field; tool results become user turns containing
 * tool_result blocks.
 */
function toAnthropic(messages: ChatMsg[]): { system: string; apiMsgs: unknown[] } {
  const system: string[] = [];
  const apiMsgs: unknown[] = [];

  for (const m of messages) {
    switch (m.role) {
      case "system":
        system.push(m.content);
        break;
      case "user":
        apiMsgs.push({ role: "user", content: m.content });
        break;
      case "assistant":
        if (m.tool_calls && m.tool_calls.length > 0) {
          const blocks: unknown[] = [];
          if (m.content) blocks.push({ type: "text", text: m.content });
          for (const tc of m.tool_calls) {
            blocks.push({
              type: "tool_use",
              id: tc.id,
              name: tc.function.name,
              input: parseJsonArgs(tc.function.arguments),
            });
          }
          apiMsgs.push({ role: "assistant", content: blocks });
        } else {
          apiMsgs.push({ role: "assistant", content: m.content });
        }
        break;
      case "tool":
        apiMsgs.push({
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: m.tool_call_id, content: m.content },
          ],
        });
        break;
    }
  }
  return { system: system.join("\n\n"), apiMsgs };
}
