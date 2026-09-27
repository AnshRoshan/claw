// types.ts — the shared vocabulary of CLAW.
//
// Everything reduces to the same three interfaces the architecture docs
// describe: Provider (the LLM), Tool (an action in the world), and the
// message shape that flows between them. We use the OpenAI wire format as the
// CANONICAL internal shape so every provider adapter is a thin translate-to-
// and-from (exactly like claw-orchestrator's anthropicProvider).

/**
 * One turn of the conversation, in OpenAI wire format. A single interface
 * (not a discriminated union) so every field is optional where appropriate
 * and callers never fight the narrowing.
 */
export interface ChatMsg {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[]; // set on assistant messages that want tools
  tool_call_id?: string; // set on tool results
}

/** A model request to run a tool. */
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Token usage as reported by a provider. All fields optional. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number; // tokens served from a provider prompt cache
  cacheWriteTokens?: number; // tokens written to a provider prompt cache
}

/** A tool definition sent to the model. */
export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** How a tool declares its security posture. */
export type Risk = "safe" | "read" | "risky";

/**
 * One action the agent can take. Mirrors the orchestrator's Tool interface:
 * Name() / Description() / Execute(). Tools are stateless; the registry owns
 * the list and the guards own the security.
 */
export interface Tool {
  name: string;
  description: string;
  /** JSON-schema-ish parameter spec, passed to the model. */
  parameters: Record<string, unknown>;
  /** safe = no approval needed, read = output scanned, risky = approval gate. */
  risk: Risk;
  /** Idempotent tools may have results cached. Shell/write NEVER are. */
  cacheable: boolean;
  execute(args: Record<string, unknown>): Promise<string>;
}

/** What a provider returns for one assistant step. */
export interface ProviderResult {
  content: string;
  /** Reasoning-model thinking (DeepSeek R1 style), when the provider streams it. */
  reasoning?: string;
  toolCalls: ToolCall[];
  usage: Usage | null;
}

/** Streaming callback — fired as text deltas arrive. */
export type TextSink = (delta: string) => void;

/**
 * The Provider interface — the first plug. A provider turns a conversation
 * plus available tools into the next assistant message, which is either text
 * (done) or tool calls (continue). Streaming is optional but every provider
 * reports usage when it can.
 */
export interface Provider {
  name: string;
  model: string;
  /** True when the provider can stream text deltas. */
  streamable: boolean;
  chat(
    messages: ChatMsg[],
    tools: ToolDef[],
    opts?: { onText?: TextSink; onReasoning?: TextSink; signal?: AbortSignal },
  ): Promise<ProviderResult>;
}

/** The Channel plug — where user input comes from. (Terminal today.) */
export interface Channel {
  name: string;
  read(): Promise<string | null>; // null = closed
}

/** Guard verdicts — the five ways a hook can shape a turn. */
export type GuardAction =
  | "continue" // proceed unchanged
  | "deny" // block the tool, feed the reason back to the model
  | "modify" // rewrite args (or the final result) then proceed
  | "abort" // stop the whole turn with a message
  | "respond"; // skip execution; give the model this text instead

export interface GuardVerdict {
  action: GuardAction;
  message?: string;
  args?: Record<string, unknown>;
  result?: string;
}

export type HookPoint =
  | "onTurnStart"
  | "beforeLLM"
  | "afterLLM"
  | "beforeTool"
  | "approveTool"
  | "afterTool"
  | "onTurnEnd";

export interface GuardCtx {
  sessionKey: string;
  messages: ChatMsg[];
  call?: ToolCall;
  args?: Record<string, unknown>;
  result?: string;
  iteration?: number;
}

/** A guard = a hook point + a decision function. Order matters. */
export interface Guard {
  point: HookPoint;
  name: string;
  check(ctx: GuardCtx): GuardVerdict | Promise<GuardVerdict>;
}
