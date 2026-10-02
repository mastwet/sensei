// work — /work <goal>: keep going until the goal is done.
// Lightweight ultrawork replacement: arms a settle-boundary loop that nudges the
// agent to continue until it emits <sensei:done/> or hits the continuation cap.
const DONE_MARKER = "<sensei:done/>";
const MAX_CONTINUATIONS = 40;

export default function (pi: any) {
  let armed = false;
  let goal = "";
  let continuations = 0;
  let lastAssistantText = "";

  pi.registerCommand("work", {
    description: "Work on a goal until done: /work <goal> to start, /work stop to disarm",
    handler: async (args: string, ctx: any) => {
      const a = args.trim();
      if (a === "stop") {
        armed = false;
        ctx.ui.notify("work: disarmed", "info");
        return;
      }
      if (!a) {
        ctx.ui.notify(
          armed ? `work: armed, ${continuations}/${MAX_CONTINUATIONS} continuations — ${goal}` : "work: not armed. Usage: /work <goal>",
          "info",
        );
        return;
      }
      armed = true;
      goal = a;
      continuations = 0;
      lastAssistantText = "";
      await ctx.sendUserMessage(
        `Goal: ${a}\n\nWork on this goal until it is completely done — do not stop to ask for confirmation. ` +
          `When, and only when, the goal is fully achieved, end your final message with the marker ${DONE_MARKER} on its own line.`,
        { deliverAs: "followUp" },
      );
    },
  });

  pi.on("message_end", (event: any) => {
    const m = event.message;
    if (m?.role === "assistant") {
      lastAssistantText = (m.content ?? [])
        .filter((c: any) => c?.type === "text")
        .map((c: any) => c.text)
        .join("\n");
    }
  });

  pi.on("agent_before_settle", (event: any) => {
    if (!armed) return;
    // An active goal owns the continuation loop; work stays armed but yields.
    if ((globalThis as any).__senseiGoalActive) return;
    // Respect user aborts and errors: never continue past them.
    if (event.outcome !== "completed" || !event.context?.canContinue || lastAssistantText.includes(DONE_MARKER)) {
      armed = false;
      return;
    }
    if (continuations >= MAX_CONTINUATIONS) {
      armed = false;
      return {
        entries: [
          {
            type: "custom_message",
            customType: "sensei.work",
            display: true,
            content: `[sensei/work] Stopped after ${MAX_CONTINUATIONS} continuations without ${DONE_MARKER}. Goal was: ${goal}`,
          },
        ],
      };
    }
    continuations += 1;
    return {
      entries: [
        {
          type: "custom_message",
          customType: "sensei.work",
          display: false,
          content:
            `[sensei/work ${continuations}/${MAX_CONTINUATIONS}] The goal is not marked done: ${goal}\n` +
            `Continue working on it now. Emit ${DONE_MARKER} on its own line only when the goal is fully achieved.`,
        },
      ],
      continue: true,
    };
  });
}
