// Deterministic model for real-host integration tests; never calls a provider.
import { appendFileSync } from "node:fs";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";

export default function (pi: any) {
  let requests = 0;
  const scenario = process.env.SENSEI_TEST_SCENARIO;
  let abortedOnce = false;
  pi.on("agent_start", (_event: any, ctx: any) => {
    if (scenario === "user-abort" && !abortedOnce) {
      abortedOnce = true;
      ctx.abort(); // Same session abort path used by RPC abort and TUI Escape.
    }
  });
  pi.on("tool_result", (event: any) => {
    appendFileSync(process.env.SENSEI_TEST_TRACE!, JSON.stringify(event) + "\n");
  });
  pi.registerProvider("sensei-test", {
    api: "sensei-test",
    baseUrl: "http://127.0.0.1:1",
    apiKey: "offline-test-key",
    models: [{
      id: "fixture", name: "Offline fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000, maxTokens: 4096,
    }],
    streamSimple(model: any, context: any) {
      requests++;
      const toolCall = (name: string, args: any) => ({ type: "toolCall", id: `call-${requests}`, name, arguments: args });
      let content: any[] = [{ type: "text", text: "host-ok" }];
      if (scenario?.startsWith("role-")) {
        const child = Number(process.env.SENSEI_DELEGATE_DEPTH ?? "0") > 0;
        if (!child && requests === 1) {
          content = [toolCall("delegate", { task: "Inspect the project without modifying it", role: scenario.slice(5), model: "sensei-test/fixture" })];
        } else if (child && requests === 1) {
          content = scenario === "role-fixer" || scenario === "role-designer"
            ? [toolCall("codemode", { code: 'text(await tools.write({path:"worker-can-write",content:"ok"})); text(await tools.delegate({task:"Forbidden nested work",role:"explorer",model:"sensei-test/fixture"}));' })]
            : [toolCall("bash", { command: 'node -e "require(\'node:fs\').writeFileSync(\'readonly-violation\',\'bad\')"' })];
        } else {
          const result = context.messages.filter((m: any) => m.role === "toolResult").at(-1);
          const text = child ? JSON.stringify({
            tools: getCurrentTools(context.messages).map((t: any) => t.name),
            legacyOverride: getCurrentSystemPrompt(context.messages).includes("LEGACY_ALIAS_OVERRIDE"),
            denied: result?.isError === true,
          }) : result?.content?.[0]?.text ?? "missing child result";
          content = [{ type: "text", text }];
        }
      } else if (scenario === "tools" && requests === 1) {
        content = [toolCall("codemode", {
          code: 'text(await tools.todo({action:"add",text:"migration verified"})); text(await tools.read({path:"nested/sample.txt"})); text(await tools.bash({command:"node --version"}));',
        })];
      } else if (scenario === "tools") {
        content = [{ type: "text", text: JSON.stringify(context.messages.filter((m: any) => m.role === "toolResult")) }];
      } else if (scenario === "work" || scenario === "user-abort") {
        content = [{ type: "text", text: requests === 1 ? "Still working." : "Finished.\n<sensei:done/>" }];
      } else if (scenario === "goal" && requests === 1) {
        content = [toolCall("update_goal", { status: "complete" })];
      } else if (scenario === "goal-cap" && requests === 1) {
        content = [toolCall("create_goal", { objective: "verify continuation cap" })];
      } else if (scenario === "goal-continuation") {
        content = requests === 1 ? [toolCall("create_goal", { objective: "verify continuation" })]
          : requests === 3 ? [toolCall("update_goal", { status: "complete" })]
          : [{ type: "text", text: requests === 2 ? "Still working." : "host-ok" }];
      } else if (scenario === "loop") {
        if (requests === 1) content = [toolCall("loop", { action: "add", task: "Scheduled check", everyMinutes: 1, times: 1 })];
        else {
          if (requests === 2) {
            const now = Date.now.bind(Date);
            Date.now = () => now() + 61000;
          }
          content = [{ type: "text", text: requests === 2 ? "Before loop." : "After loop." }];
        }
      } else if (scenario === "context") {
        content = [{ type: "text", text: JSON.stringify(context.messages.filter((m: any) => m.role === "system")) }];
      } else if (scenario === "background") {
        content = [{ type: "text", text: JSON.stringify(context.messages.filter((m: any) => m.role !== "system")) }];
      }
      const message = {
        role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: scenario === "aborted" ? "aborted" : content[0].type === "toolCall" ? "toolUse" : "stop", timestamp: Date.now(),
      };
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "start", partial: message };
          if (message.stopReason === "aborted") yield { type: "error", reason: "aborted", error: message };
          else yield { type: "done", reason: message.stopReason, message };
        },
        result: async () => message,
      };
    },
  });
  pi.registerCommand("test-custom", {
    description: "Start a custom-message run for compatibility testing",
    handler: async (_args: string, ctx: any) => {
      pi.sendMessage({ customType: "sensei.test", content: "Check context", display: false }, { triggerTurn: true });
      await ctx.waitForIdle();
    },
  });
}
