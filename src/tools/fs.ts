// tools/fs.ts — read, write, list, mkdir, delete, move. Every path is
// confined to the workspace root (defense in depth — the path-confine guard
// enforces this too). read_file paginates (offset/limit) and returns
// line-numbered text, the format coding agents cite edits against.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Tool } from "../types.ts";
import { confine } from "../util.ts";

const MAX_READ_CHARS = 100_000; // chars — keep tool results model-sized
const MAX_READ_LINES = 2000; // lines per read — page with offset/limit

/** `cat -n` style: right-aligned line numbers + a tab, over a line window. */
function numberLines(lines: string[], startLine: number): string {
  const width = String(startLine + lines.length - 1).length;
  return lines.map((l, i) => `${String(startLine + i).padStart(width)}\t${l}`).join("\n");
}

export function makeFsTools(root: string): Tool[] {
  const cwd = path.resolve(root);

  const readFile: Tool = {
    name: "read_file",
    description:
      "Read a text file from the workspace. Output is line-numbered ('N\\ttext'). For large files, page with offset (1-based first line) and limit (line count, default 2000). Use this before editing or when answering questions about code.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
        offset: { type: "number", description: "First line to read, 1-based (default 1)." },
        limit: { type: "number", description: `How many lines to read (default ${MAX_READ_LINES}, max 5000).` },
      },
      required: ["path"],
    },
    risk: "read",
    cacheable: true,
    async execute(args) {
      const p = confine(cwd, String(args.path ?? ""));
      const stat = fs.statSync(p, { throwIfNoEntry: false });
      if (!stat?.isFile()) throw new Error(`no such file: ${args.path}`);
      if (stat.size === 0) return "(empty file)";
      const text = fs.readFileSync(p, "utf8");
      const allLines = text.split("\n");
      const total = allLines.length;

      const offset = Math.max(1, Math.floor(Number(args.offset) || 1));
      const limit = Math.min(5000, Math.max(1, Math.floor(Number(args.limit) || MAX_READ_LINES)));
      if (offset > total) {
        return `offset ${offset} is past end of file (${total} lines)`;
      }
      const window = allLines.slice(offset - 1, offset - 1 + limit);
      let out = numberLines(window, offset);
      const endLine = offset + window.length - 1;
      if (endLine < total) out += `\n…[showing lines ${offset}-${endLine} of ${total} — read more with {"path":${JSON.stringify(String(args.path))},"offset":${endLine + 1}}`;
      if (out.length > MAX_READ_CHARS) out = out.slice(0, MAX_READ_CHARS) + `\n…[truncated: window exceeds ${MAX_READ_CHARS} chars]`;
      return out;
    },
  };

  const writeFile: Tool = {
    name: "write_file",
    description:
      "Create or overwrite a file inside the workspace. Creates parent directories. Use for building multi-file projects — one call per file. Prefer edit_file for small changes to an existing file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
        content: { type: "string", description: "Full file contents." },
      },
      required: ["path", "content"],
    },
    risk: "safe",
    cacheable: false,
    async execute(args) {
      const p = confine(cwd, String(args.path ?? ""));
      const content = String(args.content ?? "");
      const existed = fs.existsSync(p);
      const prev = existed ? fs.readFileSync(p, "utf8") : "";
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, "utf8");
      const added = content.split("\n").length;
      const removed = existed ? prev.split("\n").length : 0;
      return `wrote ${path.relative(cwd, p)} (${content.length} chars, ${added} lines)${existed ? ` [overwrote ${removed}-line file]` : ""}`;
    },
  };

  const listDir: Tool = {
    name: "list_dir",
    description: "List the entries of a directory inside the workspace (directories end with '/').",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Directory path relative to workspace root (default '.')." } },
    },
    risk: "read",
    cacheable: true,
    async execute(args) {
      const p = confine(cwd, String(args.path ?? "."));
      const entries = fs.readdirSync(p, { withFileTypes: true });
      const lines = entries.map((e) => (e.isDirectory() ? e.name + "/" : e.name));
      return lines.length ? lines.join("\n") : "(empty directory)";
    },
  };

  const mkdir: Tool = {
    name: "mkdir",
    description: "Create a directory (and parents) inside the workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Directory path relative to workspace root." } },
      required: ["path"],
    },
    risk: "safe",
    cacheable: false,
    async execute(args) {
      const p = confine(cwd, String(args.path ?? ""));
      fs.mkdirSync(p, { recursive: true });
      return `created ${path.relative(cwd, p)}`;
    },
  };

  const deleteFile: Tool = {
    name: "delete_file",
    description:
      "Delete a single file inside the workspace. Refuses directories (remove those with the shell tool) — and requires approval since it is destructive.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "File path relative to workspace root." } },
      required: ["path"],
    },
    risk: "risky",
    cacheable: false,
    async execute(args) {
      const p = confine(cwd, String(args.path ?? ""));
      const stat = fs.statSync(p, { throwIfNoEntry: false });
      if (!stat) throw new Error(`no such file: ${args.path}`);
      if (stat.isDirectory()) throw new Error(`"${args.path}" is a directory — use the shell tool to remove it`);
      fs.rmSync(p);
      return `deleted ${path.relative(cwd, p)}`;
    },
  };

  const moveFile: Tool = {
    name: "move_file",
    description:
      "Move or rename a file (or directory) inside the workspace from one path to another. Creates parent directories of the destination. Refuses if the destination already exists.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "Existing path relative to workspace root." },
        to: { type: "string", description: "New path relative to workspace root." },
      },
      required: ["from", "to"],
    },
    risk: "safe",
    cacheable: false,
    async execute(args) {
      const from = confine(cwd, String(args.from ?? ""));
      const to = confine(cwd, String(args.to ?? ""));
      if (!fs.existsSync(from)) throw new Error(`no such file or directory: ${args.from}`);
      if (fs.existsSync(to)) throw new Error(`destination already exists: ${args.to}`);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      return `moved ${path.relative(cwd, from)} → ${path.relative(cwd, to)}`;
    },
  };

  return [readFile, writeFile, listDir, mkdir, deleteFile, moveFile];
}
