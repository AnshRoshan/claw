// tools/todo.ts — the session task list (Claude Code's TodoWrite). The model
// maintains its own plan-of-record: a flat list of tasks with statuses. This
// is one of the highest-leverage tools in a coding harness — multi-step work
// stops drifting because every turn re-renders the plan into the context.

import type { Tool } from "../types.ts";

export type TodoStatus = "pending" | "in_progress" | "completed";
export interface TodoItem {
  content: string;
  status: TodoStatus;
}

function render(items: TodoItem[]): string {
  const boxes: Record<TodoStatus, string> = {
    pending: "[ ]",
    in_progress: "[~]",
    completed: "[x]",
  };
  const lines = items.map((t) => `${boxes[t.status] ?? "[ ]"} ${t.content}`);
  const counts = {
    completed: items.filter((t) => t.status === "completed").length,
    total: items.length,
  };
  const header =
    counts.total === 0
      ? "(task list cleared)"
      : `tasks: ${counts.completed}/${counts.total} done`;
  return [header, ...(lines.length ? ["", ...lines] : [])].join("\n");
}

export function makeTodoTool(): Tool {
  const items: TodoItem[] = [];

  return {
    name: "todo_write",
    description:
      "Write the session task list. Pass the COMPLETE list every time (it replaces the previous one) — one entry per task with status pending/in_progress/completed. Mark a task in_progress BEFORE starting it and completed immediately after finishing it. Use for any work with 2+ steps; it keeps the plan visible and prevents drift.",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "The task, imperative and specific." },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
    risk: "safe",
    cacheable: false,
    async execute(args) {
      const todos = Array.isArray(args.todos) ? args.todos : [];
      items.length = 0;
      for (const t of todos.slice(0, 50)) {
        const content = String((t as { content?: unknown }).content ?? "").trim();
        if (!content) continue;
        const raw = String((t as { status?: unknown }).status ?? "pending");
        const status: TodoStatus = raw === "in_progress" || raw === "completed" ? raw : "pending";
        items.push({ content: content.slice(0, 200), status });
      }
      return render(items);
    },
  };
}
