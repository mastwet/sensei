// todo — lightweight task list for the agent. In-memory per session.
// (State lives in the session only; branching does not restore earlier lists.)
interface Todo {
  id: number;
  text: string;
  done: boolean;
}

export default function (pi: any) {
  let todos: Todo[] = [];
  let nextId = 1;

  function render(): string {
    if (!todos.length) return "(empty)";
    return todos.map((t) => `${t.done ? "[x]" : "[ ]"} #${t.id} ${t.text}`).join("\n");
  }

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description:
      "Manage a session task list: list, add, toggle (mark done/undone), or clear items. " +
      "Use it to track multi-step work and show progress.",
    promptSnippet: "todo — track multi-step work items (list/add/toggle/clear)",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "toggle", "clear"], description: "Operation to perform" },
        text: { type: "string", description: "Todo text (required for add)" },
        id: { type: "number", description: "Todo id (required for toggle)" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(_id: string, params: any) {
      let error: string | undefined;
      switch (params.action) {
        case "add":
          if (!params.text?.trim()) error = "add requires text";
          else todos.push({ id: nextId++, text: params.text.trim(), done: false });
          break;
        case "toggle": {
          const t = todos.find((x) => x.id === params.id);
          if (!t) error = `no todo with id ${params.id}`;
          else t.done = !t.done;
          break;
        }
        case "clear":
          todos = [];
          break;
        case "list":
          break;
        default:
          error = `unknown action ${params.action}`;
      }
      const body = error ? `error: ${error}\n${render()}` : render();
      return {
        content: [{ type: "text", text: body }],
        details: { todos: todos.map((t) => ({ ...t })), error },
        ...(error ? { isError: true } : {}),
      };
    },
  });

  pi.registerCommand("todos", {
    description: "Show the session todo list",
    handler: async (_args: string, ctx: any) => {
      ctx.ui.notify(render(), "info");
    },
  });
}
