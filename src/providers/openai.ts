// providers/openai.ts — OpenAI-compatible provider with SSE streaming.
//
// Speaks the chat/completions wire format, which is ALSO our internal
// canonical format, so the adapter here is nearly transparent. Works against
// OpenAI, the OmniRoute gateway, Ollama, LM Studio, vLLM, etc.

import type { ChatMsg, Provider, ProviderResult, ToolCall, ToolDef, Usage } from "../types.ts";
import { isRetryableStatus, parseJsonArgs, retryAfterMs, RetryableError, sseEvents, withRetry } from "../util.ts";

interface WireToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface WireChoice {
  delta?: {
    content?: string | null;
    tool_calls?: WireToolCallDelta[];
  };
  finish_reason?: string | null;
}

interface WireChunk {
  choices?: WireChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

export class OpenAIProvider implements Provider {
  readonly streamable = true;
  readonly name = "openai-compatible";
  readonly baseURL: string;
  readonly apiKey: string | undefined;
  readonly model: string;

  constructor(baseURL: string, apiKey: string | undefined, model: string) {
    this.baseURL = baseURL;
    this.apiKey = apiKey;
    this.model = model;
  }

  async chat(
    messages: ChatMsg[],
    tools: ToolDef[],
    opts?: { onText?: (d: string) => void; onReasoning?: (d: string) => void; signal?: AbortSignal },
  ): Promise<ProviderResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(stripToolCallType),
      tools,
      stream: true,
      stream_options: { include_usage: true },
    };

    // If a server rejects stream_options (older Ollama/vLLM), retry cleanly.
    try {
      return await this.streamChat(body, opts);
    } catch (err) {
      const msg = (err as Error).message;
      if (/stream_options|include_usage/i.test(msg)) {
        delete body.stream_options;
        return await this.streamChat(body, opts);
      }
      throw err;
    }
  }

  private async streamChat(
    body: Record<string, unknown>,
    opts?: { onText?: (d: string) => void; onReasoning?: (d: string) => void; signal?: AbortSignal },
  ): Promise<ProviderResult> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    // Retry only the request/response phase — never a partial stream (which
    // would double-emit text). A RetryableError marks transient statuses and
    // network drops; everything else fails fast.
    const resp = await withRetry(
      async () => {
        let r: Response;
        try {
          r = await fetch(this.baseURL.replace(/\/+$/, "") + "/chat/completions", {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: opts?.signal,
          });
        } catch (err) {
          if ((err as Error).name === "AbortError") throw err;
          throw new RetryableError(`network error contacting ${this.name}: ${(err as Error).message}`);
        }
        if (!r.ok) {
          const detail = (await r.text().catch(() => "")).slice(0, 300);
          const msg = `HTTP ${r.status} from ${this.name}: ${detail || r.statusText}`;
          if (isRetryableStatus(r.status)) throw new RetryableError(msg, retryAfterMs(r));
          throw new Error(msg);
        }
        return r;
      },
      { signal: opts?.signal },
    );

    let content = "";
    let reasoning = "";
    let usage: Usage | null = null;
    const toolAcc: WireToolCallDelta[] = [];

    await sseEvents(
      resp,
      (data) => {
        if (!data || data === "[DONE]") return;
        let chunk: WireChunk;
        try {
          chunk = JSON.parse(data) as WireChunk;
        } catch {
          return;
        }
        const choice = chunk.choices?.[0];
        if (!choice) {
          if (chunk.usage) usage = mapUsage(chunk.usage);
          return;
        }
        const delta = choice.delta ?? {};
        // Reasoning models (DeepSeek R1, OpenRouter thinking models) stream
        // their thinking on a separate field before the answer.
        const think = (delta as { reasoning_content?: string; reasoning?: string }).reasoning_content
          ?? (delta as { reasoning?: string }).reasoning;
        if (think) {
          reasoning += think;
          opts?.onReasoning?.(think);
        }
        if (delta.content) {
          content += delta.content;
          opts?.onText?.(delta.content);
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? toolAcc.length;
            toolAcc[idx] ??= { index: idx };
            if (tc.id) toolAcc[idx].id = tc.id;
            if (tc.function?.name) toolAcc[idx].function ??= {};
            if (tc.function?.name) toolAcc[idx].function!.name = tc.function.name;
            if (tc.function?.arguments) {
              toolAcc[idx].function ??= {};
              toolAcc[idx].function!.arguments =
                (toolAcc[idx].function!.arguments ?? "") + tc.function.arguments;
            }
          }
        }
      },
      opts?.signal,
    );

    const toolCalls: ToolCall[] = toolAcc
      .filter((t) => t.function?.name)
      .map((t, i) => ({
        id: t.id ?? `call_${i}`,
        type: "function" as const,
        function: {
          name: t.function!.name!,
          arguments: t.function!.arguments ?? "{}",
        },
      }));

    return { content, reasoning: reasoning || undefined, toolCalls, usage };
  }
}

/** The tool role's `type` field is not part of the OpenAI wire format. */
function stripToolCallType(msgs: ChatMsg): unknown {
  return msgs.role === "tool" ? { role: "tool", tool_call_id: msgs.tool_call_id, content: msgs.content } : msgs;
}

function mapUsage(u: WireChunk["usage"]): Usage {
  return {
    inputTokens: u?.prompt_tokens ?? 0,
    outputTokens: u?.completion_tokens ?? 0,
    cacheReadTokens: u?.prompt_tokens_details?.cached_tokens,
  };
}

// Re-export for other modules that want to parse args the same way.
export { parseJsonArgs };
