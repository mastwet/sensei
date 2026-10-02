// waitfor — port of omo-slim tools/wait-for-user, sensei edition.
// Tool that marks the agent as waiting on an external human action: returns a
// state block telling the model to end its turn; the next user message resumes
// normal continuation. Warns instead when background delegates are still
// outstanding (their completion resumes the session automatically).

import { bgTasks } from "./delegate.ts";

export default function waitfor(pi: any): void {
  pi.registerTool({
    name: "wait_for_user",
    label: "Wait For User",
    description:
      "Pause automatic continuation while waiting for external human action.\n\n" +
      "Use this only as the final tool action after you have already given the user concrete manual steps. " +
      "The next distinct user message resumes normal continuation. For an immediate answer, choice, " +
      "clarification, or pasted output, ask in normal text instead. Background delegate tasks are not " +
      "external manual work — do not use this tool to await them; their results are injected automatically when they finish.",
    promptSnippet: "wait_for_user — end turn and pause until the user completes a manual action",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Short description of the external human action being awaited",
          maxLength: 500,
        },
      },
      required: ["reason"],
      additionalProperties: false,
    },
    async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const reason = String(params.reason ?? "").replace(/\s+/g, " ").trim();
      if (!reason) throw new Error("wait_for_user requires a non-empty reason");

      const running = [...bgTasks.values()].filter((t) => t.status === "running");
      if (running.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: [
                "state: waiting_for_user_skipped",
                `reason: ${reason}`,
                "",
                `${running.length} background task(s) still running (${running.map((t) => t.id).join(", ")}). ` +
                  "Do not block on manual input — end this turn now. Task results are injected automatically when they finish.",
              ].join("\n"),
            },
          ],
          details: { state: "skipped", running: running.map((t) => t.id) },
        };
      }

      ctx.ui?.notify?.(`waiting for user: ${reason}`, "info");
      return {
        content: [
          {
            type: "text",
            text: [
              "state: waiting_for_user",
              "protocol: sensei.wait_for_user.v1",
              `reason: ${reason}`,
              "",
              "End this turn now. Do not call more tools until the user responds.",
            ].join("\n"),
          },
        ],
        details: { state: "waiting_for_user" },
      };
    },
  });
}
