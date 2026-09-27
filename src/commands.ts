// commands.ts — user-defined slash commands, the same trick as Claude Code's
// custom commands: a markdown file named `<name>.md` in `.claw/commands/`
// (workspace) or `~/.claw/commands/` (user) becomes a `/name` command in the
// REPL. `$ARGUMENTS` in the template is replaced with whatever the user
// typed after the command. Workspace commands shadow user commands.

import * as fs from "node:fs";
import * as path from "node:path";

export interface ClawCommand {
  name: string;
  /** The raw template text (with $ARGUMENTS placeholders). */
  template: string;
  /** Where it came from — shown in /help. */
  source: "workspace" | "user";
}

function commandDir(root: "workspace" | "user", workspace: string, homeDir: string): string {
  return root === "workspace" ? path.join(workspace, ".claw", "commands") : path.join(homeDir, "commands");
}

/** Look up one command by name. Workspace overrides user. */
export function findCommand(name: string, workspace: string, homeDir: string): ClawCommand | null {
  for (const root of ["workspace", "user"] as const) {
    const p = path.join(commandDir(root, workspace, homeDir), `${name}.md`);
    try {
      const template = fs.readFileSync(p, "utf8").trim();
      if (template) return { name, template, source: root };
    } catch {
      /* try the next scope */
    }
  }
  return null;
}

/** All defined commands, for /help. */
export function listCommands(workspace: string, homeDir: string): ClawCommand[] {
  const out = new Map<string, ClawCommand>();
  for (const root of ["user", "workspace"] as const) {
    const dir = commandDir(root, workspace, homeDir);
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3));
    } catch {
      /* no commands dir at this scope */
    }
    for (const name of names) {
      const cmd = findCommand(name, workspace, homeDir);
      if (cmd) out.set(name, cmd);
    }
  }
  return [...out.values()];
}

/**
 * Expand a template: `$ARGUMENTS` (or `{args}`) becomes the full argument
 * string; `$1..$9` become individual whitespace-split words.
 */
export function renderCommand(template: string, args: string): string {
  const words = args.trim().split(/\s+/).filter(Boolean);
  let out = template.replaceAll("$ARGUMENTS", args.trim()).replaceAll("{args}", args.trim());
  out = out.replaceAll(/\$(\d)/g, (_, n: string) => words[Number(n) - 1] ?? "");
  return out;
}
