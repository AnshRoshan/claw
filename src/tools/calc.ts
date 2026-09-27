// tools/calc.ts — a small safe arithmetic evaluator. No eval(): a tiny
// precedence-climbing parser handles + - * / ( ) and ^ correctly.

import type { Tool } from "../types.ts";

export function makeCalcTool(): Tool {
  return {
    name: "calc",
    description:
      "Evaluate a mathematical expression like '12 * 9', '(3 + 4) * 2', or '2^8'. Returns the numeric result.",
    parameters: {
      type: "object",
      properties: { expr: { type: "string", description: "The expression to evaluate." } },
      required: ["expr"],
    },
    risk: "safe",
    cacheable: true,
    async execute(args) {
      const expr = String(args.expr ?? "").trim();
      const tokens = tokenize(expr);
      if (tokens.length === 0) throw new Error("empty expression");
      const r = parseExpr(tokens, 0, 0);
      if (r.pos !== tokens.length) {
        throw new Error(`trailing tokens after "${tokens[r.pos]?.value ?? "?"}"`);
      }
      // Round away float noise (0.30000000000000004 → 0.3).
      return String(Math.round(r.value * 1e10) / 1e10);
    },
  };
}

interface Token {
  kind: "num" | "op" | "lparen" | "rparen";
  value: string;
}

function tokenize(s: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      const num = s.slice(i, j);
      if (!/^\d+(\.\d+)?$/.test(num)) throw new Error(`bad number: ${num}`);
      out.push({ kind: "num", value: num });
      i = j;
      continue;
    }
    if ("+-*/^".includes(ch)) {
      out.push({ kind: "op", value: ch });
      i++;
      continue;
    }
    if (ch === "(") {
      out.push({ kind: "lparen", value: ch });
      i++;
      continue;
    }
    if (ch === ")") {
      out.push({ kind: "rparen", value: ch });
      i++;
      continue;
    }
    throw new Error(`unexpected character: ${ch}`);
  }
  return out;
}

const PREC: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2, "^": 3 };

/**
 * Precedence-climbing expression parser. Returns the value and the position
 * one PAST the last consumed token, so callers can chain operators. `start`
 * is where this subexpression begins — the earlier bug reset it to 0 on every
 * recursion, which looped forever on "7 * 6".
 */
function parseExpr(tokens: Token[], start: number, minPrec: number): { value: number; pos: number } {
  let pos = start;
  let left: number;
  const first = tokens[pos];
  if (!first) throw new Error("unexpected end of expression");
  if (first.kind === "lparen") {
    const inner = parseExpr(tokens, pos + 1, 0);
    if (tokens[inner.pos]?.kind !== "rparen") throw new Error("missing )");
    left = inner.value;
    pos = inner.pos + 1;
  } else if (first.kind === "num") {
    left = Number(first.value);
    pos = start + 1;
  } else {
    throw new Error(`expected a number, got "${first.value}"`);
  }

  while (pos < tokens.length) {
    const tok = tokens[pos];
    if (tok.kind === "rparen") break;
    if (tok.kind !== "op") throw new Error(`expected operator, got "${tok.value}"`);
    const prec = PREC[tok.value];
    if (prec < minPrec) break;
    // Right-associative ^ (2^3^2 = 2^9); everything else left-associative.
    const rhs = parseExpr(tokens, pos + 1, prec + (tok.value === "^" ? 0 : 1));
    const right = rhs.value;
    pos = rhs.pos;
    switch (tok.value) {
      case "+": left += right; break;
      case "-": left -= right; break;
      case "*": left *= right; break;
      case "/":
        if (right === 0) throw new Error("division by zero");
        left /= right;
        break;
      case "^": left = left ** right; break;
    }
  }
  return { value: left, pos };
}
