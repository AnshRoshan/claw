// tools/edit.ts — surgical search/replace edits. The model reads a file, then
// applies small diffs instead of rewriting the whole thing. This is how
// coding agents keep edits cheap and precise.
//
// Two shapes: the legacy single edit (old_string/new_string) and an `edits`
// array applied IN ORDER. An array is atomic — if any old_string fails to
// match, nothing is written and the failure names the offending edit.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Tool } from "../types.ts";
import { confine } from "../util.ts";

interface SingleEdit {
  old_string: string;
  new_string: string;
  replace_all: boolean;
}

/** Apply one search/replace to `text`, or throw with a precise reason. */
function applyEdit(text: string, e: SingleEdit, label: string): { text: string; count: number } {
  if (!e.old_string) throw new Error(`${label}: old_string must not be empty`);
  if (!text.includes(e.old_string)) {
    throw new Error(`${label}: old_string not found. Read the file first and copy the EXACT text.`);
  }
  if (e.replace_all) {
    const count = text.split(e.old_string).length - 1;
    return { text: text.split(e.old_string).join(e.new_string), count };
  }
  return { text: text.replace(e.old_string, e.new_string), count: 1 };
}

function lineDelta(oldStr: string, newStr: string): string {
  const removed = oldStr.split("\n").length;
  const added = newStr.split("\n").length;
  return `+${added}/-${removed} lines`;
}

export function makeEditTool(root: string): Tool {
  const cwd = path.resolve(root);

  return {
    name: "edit_file",
    description:
      "Apply exact search-and-replace edits to a file. Either one edit (old_string/new_string) or an `edits` array applied in order (atomic: if any old_string is missing, nothing is written). old_string must match EXACTLY. Use replace_all only when the same pattern should change everywhere. Prefer the smallest unique old_string.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to workspace root." },
        old_string: { type: "string", description: "Exact text to find (single-edit form)." },
        new_string: { type: "string", description: "Replacement text (single-edit form)." },
        replace_all: { type: "boolean", description: "Replace every occurrence (default false)." },
        edits: {
          type: "array",
          description: "Multiple edits applied in order, atomically. Later edits see earlier results.",
          items: {
            type: "object",
            properties: {
              old_string: { type: "string", description: "Exact text to find." },
              new_string: { type: "string", description: "Replacement text." },
              replace_all: { type: "boolean", description: "Replace every occurrence (default false)." },
            },
            required: ["old_string", "new_string"],
          },
        },
      },
      required: ["path"],
    },
    risk: "safe",
    cacheable: false,
    async execute(args) {
      const p = confine(cwd, String(args.path ?? ""));
      const rawEdits = Array.isArray(args.edits) ? args.edits : null;

      const edits: SingleEdit[] = rawEdits
        ? rawEdits.map((e, i) => {
            const o = e as Record<string, unknown>;
            return {
              old_string: String(o.old_string ?? ""),
              new_string: String(o.new_string ?? ""),
              replace_all: o.replace_all === true,
              label: `edit ${i + 1}`,
            } as SingleEdit & { label: string };
          })
        : [{
            old_string: String(args.old_string ?? ""),
            new_string: String(args.new_string ?? ""),
            replace_all: args.replace_all === true,
            label: "edit",
          } as SingleEdit & { label: string }];
      if (!edits.length) throw new Error("edits array is empty");

      const text = fs.readFileSync(p, "utf8");
      let out = text;
      let total = 0;
      const deltas: string[] = [];
      for (const e of edits) {
        const label = (e as SingleEdit & { label: string }).label;
        // Atomic: any failed match aborts BEFORE any write happens.
        const r = applyEdit(out, e, label);
        out = r.text;
        total += r.count;
        deltas.push(lineDelta(e.old_string, e.new_string));
      }
      fs.writeFileSync(p, out, "utf8");
      const summary = deltas.length === 1 ? ` (${deltas[0]})` : ` (${deltas.length} edits, ${deltas.join(", ")})`;
      return `edited ${path.relative(cwd, p)}: ${total} replacement(s)${summary}`;
    },
  };
}
