// render.ts — the terminal UI. Zero dependencies, pure ANSI.
//
// The centerpiece is `Screen`, which coordinates TWO kinds of output that
// interleave during a turn:
//   - streamed assistant text, rendered as a chat panel with a left gutter
//     (│ ...) and auto-wrapping, closed with └─ when the model pauses or ends
//   - trace / status lines, which first flush the panel so nothing glues
//
// `printAssistant` is the rich (non-streaming) renderer: headers, bold,
// inline code, lists, blockquotes, tables, and fenced code blocks.
// Everything degrades gracefully when piped (ANSI codes are fine; we never
// depend on cursor motion except the spinner).

import * as readline from "node:readline";
import { bold, cyan, dim, green, magenta, red, yellow } from "./util.ts";

export { bold, cyan, dim, green, magenta, red, yellow };

const RESET = "\x1b[0m";

function width(): number {
  return (process.stdout.columns ?? 100) - 2;
}

function plain(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ── the banner ─────────────────────────────────────────────────────

export function makeBanner(version?: string): string {
  const tag = `terminal coding agent${version ? ` · v${version}` : ""}`;
  const inner = ` CLAW — ${tag} `;
  const bar = "─".repeat(Math.max(10, width() - 2));
  return (
    "\n" +
    green("  ╭" + bar + "╮") + "\n" +
    green("  │") + bold(`   ${inner}`.trimEnd()) + " ".repeat(Math.max(0, width() - 2 - plain(inner).length)) + green("│") + "\n" +
    dim("  │ ") + dim("chat · code · search · sub-agents · MCP") + " ".repeat(Math.max(0, width() - 2 - 37)) + green("│") + "\n" +
    green("  ╰" + bar + "╯")
  );
}

// ── the streaming panel ────────────────────────────────────────────

/**
 * A chat panel for streamed assistant text. Feeds deltas, wraps at the
 * terminal width, prefixes every line with a gutter, renders fenced code
 * blocks with a cyan gutter, and closes with └─ when flushed or ended.
 */
class Panel {
  private buf = "";
  private inFence = false;
  private open = false;
  private max = Math.max(20, width() - 4);

  feed(text: string): void {
    for (const ch of text) {
      if (ch === "\n") {
        this.emitLine();
        this.buf = "";
      } else {
        this.buf += ch;
        if (plain(this.buf).length >= this.max) {
          this.emitLine();
          this.buf = ""; // keep only the unwrapped remainder
        }
      }
    }
  }

  private emitLine(): void {
    const raw = this.buf;
    this.buf = ""; // consume — never emit a stale line twice
    const trimmed = raw.trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      if (!this.inFence) {
        const lang = trimmed.slice(3).trim();
        process.stdout.write(dim(cyan("  ┌─ ")) + (lang ? dim(`code: ${lang}`) : dim("code")) + "\n");
        this.inFence = true;
      } else {
        process.stdout.write(dim("  └─") + "\n");
        this.inFence = false;
      }
      this.open = true;
      return;
    }
    const gutter = dim(this.inFence ? cyan("  │ ") : "  │ ");
    process.stdout.write(gutter + (this.inFence ? cyan(raw) : raw) + "\n");
    this.open = true;
  }

  /** Close any open line and finish the panel with a corner. */
  close(): void {
    if (this.buf !== "") this.emitLine();
    if (this.open) {
      process.stdout.write(dim("  └─") + "\n");
      this.open = false;
    }
  }

  /** Pending text still buffered? (Used before trace lines.) */
  hasPending(): boolean {
    return this.buf !== "" || this.open;
  }

  /** Drop any buffered partial without printing (turn ended mid-line). */
  discard(): void {
    this.buf = "";
    if (this.open) {
      process.stdout.write(dim("  └─") + "\n");
      this.open = false;
    }
    this.inFence = false;
  }
}

// ── the screen coordinator ─────────────────────────────────────────

export interface ScreenStyle {
  trace?: (s: string) => string;
}

export class Screen {
  private panel = new Panel();
  private style: ScreenStyle;

  constructor(style: ScreenStyle = {}) {
    this.style = style;
  }

  /** Stream assistant text into the panel. */
  stream(text: string): void {
    this.panel.feed(text);
  }

  /** Print a trace/status line — flushes the panel first so nothing glues. */
  line(s: string): void {
    if (this.panel.hasPending()) this.panel.close();
    const out = this.style.trace ? this.style.trace(s) : s;
    process.stdout.write(out + "\n");
  }

  /** Finish the turn: close the panel if it's still open. */
  end(): void {
    this.panel.close();
  }

  /** Abandon a partial stream (e.g. no final answer). */
  abort(): void {
    this.panel.discard();
  }

  /** A raw line that should never touch the panel (headers, blank lines). */
  raw(s: string): void {
    process.stdout.write(s + "\n");
  }
}

/** Colorize an agent trace line by its leading marker. */
export function styleTrace(s: string): string {
  const t = s.trimStart();
  const lead = t.slice(0, 2);
  switch (lead) {
    case "⚙ ": return "  " + cyan(bold("⚙")) + dim(" " + t.slice(2));
    case "▶ ": return "  " + yellow(bold("▶")) + dim(" " + t.slice(2));
    case "◀ ": return "  " + green("◀") + dim(" " + t.slice(2));
    case "✗ ": return "  " + red("✗") + dim(" " + t.slice(2));
    case "! ": return "  " + red(bold("!")) + " " + t.slice(2);
    case "⚡": return "  " + magenta("⚡") + dim(" " + t.slice(3));
    case "↻ ": return "  " + dim("↻ " + t.slice(2));
    case "⋮ ": return "  " + magenta("⋮") + dim(" " + t.slice(2));
    case "· ": return "  " + dim(t);
    default: return "  " + dim(t);
  }
}

// ── status chips ───────────────────────────────────────────────────

/** `✻ 3 tool calls · in 1.2k · out 800 · cached 512 · $0.004`. */
export function turnSummary(parts: Array<string | null>): string {
  const nonNull = parts.filter((p): p is string => !!p);
  return dim("  ✻ " + nonNull.join(dim(" · ")));
}

/** A small labeled chip: `model openai-compatible / free-stack`. */
export function chip(label: string, value: string): string {
  return `${dim(label + " ")}${value}`;
}

// ── rich markdown (non-streaming) rendering ────────────────────────

export function printAssistant(text: string): void {
  const trimmed = text.replace(/\s+$/, "");
  if (!trimmed) return;
  const lines = trimmed.split("\n");
  let inCode = false;

  for (const line of lines) {
    const fence = line.match(/^\s*(```+|~~~+)\s*(\S*)/);
    if (fence) {
      if (!inCode) {
        const lang = fence[2] ?? "";
        process.stdout.write(dim(cyan("  ┌─ ")) + (lang ? dim(`code: ${lang}`) : dim("code")) + "\n");
        inCode = true;
      } else {
        process.stdout.write(dim("  └─") + "\n");
        inCode = false;
      }
      continue;
    }
    if (inCode) {
      process.stdout.write(dim(cyan("  │ ")) + cyan(line) + "\n");
      continue;
    }
    const trimmedLine = line.trimEnd();
    if (!trimmedLine.trim()) {
      process.stdout.write("\n");
      continue;
    }

    // horizontal rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(trimmedLine)) {
      process.stdout.write(dim("  " + "─".repeat(Math.max(10, Math.floor(width() / 2)))) + "\n");
      continue;
    }
    // headings
    const header = trimmedLine.match(/^(#{1,4})\s+(.*)/);
    if (header) {
      const level = header[1].length;
      const color = level === 1 ? yellow : level === 2 ? cyan : green;
      const label = level === 1 ? "◆ " : level === 2 ? "● " : "· ";
      process.stdout.write("  " + color(bold(label + inline(header[2]))) + "\n");
      continue;
    }
    // blockquote
    const quote = trimmedLine.match(/^\s*>\s?(.*)/);
    if (quote) {
      process.stdout.write(dim("  │ ") + dim(quote[1]) + "\n");
      continue;
    }
    // unordered list
    const bullet = trimmedLine.match(/^\s*[-*+]\s+(.*)/);
    if (bullet) {
      process.stdout.write("  " + magenta("• ") + inline(bullet[1]) + "\n");
      continue;
    }
    // ordered list
    const ordered = trimmedLine.match(/^\s*(\d+)[.)]\s+(.*)/);
    if (ordered) {
      process.stdout.write(`  ${dim(ordered[1] + ".")} ${inline(ordered[2])}\n`);
      continue;
    }
    // table row
    if (trimmedLine.startsWith("|") && trimmedLine.includes("|")) {
      process.stdout.write("  " + dim(trimmedLine) + "\n");
      continue;
    }
    process.stdout.write("  " + inline(trimmedLine) + "\n");
  }
  process.stdout.write("\n");
}

/** Inline markdown on one line: **bold**, `code`, and *em*. */
function inline(s: string): string {
  let out = s;
  // code spans first (so we don't color inside them)
  const spans: Array<{ start: number; end: number; text: string }> = [];
  const re = /`([^`]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(out))) {
    spans.push({ start: m.index, end: m.index + m[0].length, text: m[1] });
  }
  if (spans.length) {
    let result = "";
    let pos = 0;
    for (const sp of spans) {
      result += inlineBold(out.slice(pos, sp.start));
      result += dim(sp.text);
      pos = sp.end;
    }
    result += inlineBold(out.slice(pos));
    out = result;
  } else {
    out = inlineBold(out);
  }
  return out;
}

function inlineBold(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, (_m, g: string) => bold(g))
    .replace(/\*([^*]+)\*/g, (_m, g: string) => dim(g))
    .replace(/__([^_]+)__/g, (_m, g: string) => bold(g));
}

// ── spinner ────────────────────────────────────────────────────────

export function startThinking(label = "thinking"): NodeJS.Timeout {
  const frames = ["◐", "◓", "◑", "◒"];
  let i = 0;
  process.stdout.write(dim("  " + frames[0] + " " + label));
  return setInterval(() => {
    process.stdout.write(`\r${dim(`  ${frames[i++ % frames.length]} ${label}`)}`);
  }, 120);
}

export function stopThinking(timer: NodeJS.Timeout | undefined): void {
  if (timer) {
    clearInterval(timer);
    process.stdout.write("\r\x1b[K");
  }
}

// ── approval prompt ────────────────────────────────────────────────

export async function askYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = await new Promise<string>((resolve) => {
      rl.question("\n" + yellow("  ⚠ ") + question + " [y/N] ", resolve);
    });
    return ["y", "yes"].includes(ans.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

export function banner(): void {
  process.stdout.write(makeBanner() + "\n");
}

export function statusLine(parts: string[]): void {
  process.stdout.write(dim("  " + parts.join(" · ")) + "\n");
}
