// tools/search.ts — glob (find files by name pattern) and grep (find text in
// files). These give the model X-ray vision over the workspace without
// reading everything. grep supports context lines, literal mode, case
// control, files-only, and multiline — the ripgrep feature set that matters.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Tool } from "../types.ts";
import { confine } from "../util.ts";

const IGNORE = new Set([".git", "node_modules", "dist", "build", ".next", ".venv", "target", "vendor", ".claw"]);
const MAX_FILES = 2000;
const MAX_MATCHES = 120;
const MAX_BYTES = 2 * 1024 * 1024; // skip huge/binary files

function walk(root: string, relDir: string, out: string[]): void {
  if (out.length >= MAX_FILES) return;
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, relDir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue;
    const rel = path.posix.join(relDir, e.name);
    if (e.isDirectory()) walk(root, rel, out);
    else out.push(rel);
    if (out.length >= MAX_FILES) return;
  }
}

function isBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8192);
  return sample.includes(0);
}

/** Escape a literal string so it can be used as a RegExp source. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function makeSearchTools(root: string): Tool[] {
  const cwd = path.resolve(root);

  const glob: Tool = {
    name: "glob",
    description:
      "Find files by name pattern (e.g. '**/*.ts', 'src/**/*.test.*', '*.md'), optionally under a sub-directory. Returns paths sorted newest-first by modification time. node_modules and build dirs are skipped.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern relative to workspace root." },
        path: { type: "string", description: "Sub-directory to search under (default workspace root)." },
        head_limit: { type: "number", description: "Max paths to return (default 200)." },
      },
      required: ["pattern"],
    },
    risk: "read",
    cacheable: true,
    async execute(args) {
      const pattern = String(args.pattern ?? "");
      if (!pattern) throw new Error("pattern is required");
      const base = args.path ? confine(cwd, String(args.path)) : cwd;
      const limit = Math.max(1, Math.floor(Number(args.head_limit) || 200));
      const re = globToRegExp(pattern);
      const files: string[] = [];
      walk(base, ".", files);
      const hits = files.filter((f) => re.test(f));
      // Sort newest-modified first, like the best coding agents.
      const withMtime = hits.map((rel) => {
        let m = 0;
        try {
          m = fs.statSync(path.join(base, rel)).mtimeMs;
        } catch {
          /* unreadable — sort last */
        }
        return { rel, m };
      });
      withMtime.sort((a, b) => b.m - a.m);
      const outPaths = withMtime.slice(0, limit).map((h) => h.rel);
      return outPaths.length ? outPaths.join("\n") : "(no files matched)";
    },
  };

  const grep: Tool = {
    name: "grep",
    description:
      "Search file contents. Returns 'path:line: text' matches, optionally with surrounding context lines. Use for finding where things are defined or referenced.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression (or literal text if literal=true)." },
        glob: { type: "string", description: "Optional file filter, e.g. '**/*.ts'." },
        path: { type: "string", description: "Sub-directory to search under (default workspace root)." },
        literal: { type: "boolean", description: "Treat pattern as a literal string, not a regex (default false)." },
        case_sensitive: { type: "boolean", description: "Match case exactly (default false = case-insensitive)." },
        multiline: { type: "boolean", description: "Let the pattern span lines (. matches newlines); matches whole blocks." },
        context_before: { type: "number", description: "Include N lines before each match (like rg -B)." },
        context_after: { type: "number", description: "Include N lines after each match (like rg -A)." },
        files_only: { type: "boolean", description: "Return only matching file paths, not lines (like rg -l)." },
        head_limit: { type: "number", description: `Max matches to return (default ${MAX_MATCHES}).` },
      },
      required: ["pattern"],
    },
    risk: "read",
    cacheable: true,
    async execute(args) {
      const src = String(args.pattern);
      if (!src) throw new Error("pattern is required");
      const literal = args.literal === true;
      const multiline = args.multiline === true;
      const ci = args.case_sensitive !== true;
      let re: RegExp;
      try {
        const flags = "g" + (ci ? "i" : "") + (multiline ? "s" : "");
        re = new RegExp(literal ? escapeRe(src) : src, flags);
      } catch (err) {
        throw new Error(`bad regex: ${(err as Error).message}`);
      }
      const fileFilter = args.glob ? globToRegExp(String(args.glob)) : null;
      const base = args.path ? confine(cwd, String(args.path)) : cwd;
      const before = Math.min(Math.max(Math.floor(Number(args.context_before) || 0), 0), 20);
      const after = Math.min(Math.max(Math.floor(Number(args.context_after) || 0), 0), 20);
      const filesOnly = args.files_only === true;
      const limit = Math.max(1, Math.floor(Number(args.head_limit) || MAX_MATCHES));

      const files: string[] = [];
      walk(base, ".", files);

      const out: string[] = [];
      const seen = new Set<string>();
      for (const rel of files) {
        if (fileFilter && !fileFilter.test(rel)) continue;
        const abs = path.join(base, rel);
        const stat = fs.statSync(abs, { throwIfNoEntry: false });
        if (!stat || stat.size > MAX_BYTES) continue;
        const buf = fs.readFileSync(abs);
        if (isBinary(buf)) continue;
        const content = buf.toString("utf8");

        if (multiline) {
          // Whole-content match: report the offset's line number + a snippet.
          re.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = re.exec(content))) {
            const lineNo = content.slice(0, m.index).split("\n").length;
            if (filesOnly) {
              if (!seen.has(rel)) {
                seen.add(rel);
                out.push(rel);
                if (out.length >= limit) return out.join("\n") + "\n…[truncated]";
              }
            } else {
              out.push(`${rel}:${lineNo}: ${m[0].replace(/\s+/g, " ").slice(0, 200)}`);
              if (out.length >= limit) return out.join("\n") + "\n…[truncated]";
            }
            if (m.index === re.lastIndex) re.lastIndex++; // avoid zero-width loops
          }
          continue;
        }

        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          re.lastIndex = 0;
          if (re.test(lines[i])) {
            if (filesOnly) {
              if (!seen.has(rel)) {
                seen.add(rel);
                out.push(rel);
                if (out.length >= limit) return out.join("\n") + "\n…[truncated]";
              }
              break; // one hit per file is enough for files-only
            }
            for (let b = before; b > 0; b--) {
              if (i - b >= 0) out.push(`${rel}:${i - b + 1}- ${lines[i - b].slice(0, 200)}`);
            }
            out.push(`${rel}:${i + 1}: ${lines[i].slice(0, 200)}`);
            for (let a = 1; a <= after; a++) {
              if (i + a < lines.length) out.push(`${rel}:${i + a + 1}- ${lines[i + a].slice(0, 200)}`);
            }
            if (out.length >= limit) return out.join("\n") + "\n…[truncated]";
          }
        }
      }
      return out.length ? out.join("\n") : "(no matches)";
    },
  };

  return [glob, grep];
}

/** Tiny glob→RegExp converter (supports *, **, ?, {a,b}, [abc]). */
export function globToRegExp(glob: string): RegExp {
  let out = "^";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // **/ matches any number of path segments (including none); consume
        // the following slash so `**/*.ts` still matches src/a/b.ts.
        out += "(?:.*/)?";
        i += 2;
        if (glob[i] === "/") i++;
        continue;
      }
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "{") {
      const end = glob.indexOf("}", i);
      if (end > i) {
        const alts = glob.slice(i + 1, end).split(",").map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        out += "(?:" + alts.join("|") + ")";
        i = end;
      } else {
        out += "\\{";
      }
    } else if (ch === "[") {
      const end = glob.indexOf("]", i);
      if (end > i) {
        out += glob.slice(i, end + 1);
        i = end;
      } else {
        out += "\\[";
      }
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    i++;
  }
  out += "$";
  return new RegExp(out);
}

export { confine };
