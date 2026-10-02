// sensei btw — slim port of senpi's builtin/btw.
// /btw <question>: side query on the current conversation via
// ctx.modelRegistry.streamSimple — no subprocess, no session mutation.
// Bare /btw cancels an in-flight query.

const SIDE_QUERY_INSTRUCTION =
	"The user is asking a side question about the conversation so far, outside the main task. " +
	"Answer it directly and concisely from the context above. " +
	"Do not continue any task, do not modify anything, and do not treat this as new work.";

const MAX_TRANSCRIPT_CHARS = 60_000;
const ESTABLISHMENT_TIMEOUT_MS = 60_000;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((p: any) => (p && p.type === "text" ? String(p.text ?? "") : ""))
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

function buildTranscript(ctx: any): string {
	const entries = ctx.sessionManager?.getEntries?.() ?? [];
	const lines: string[] = [];
	for (const e of entries) {
		if (e.type !== "message") continue;
		const role = e.message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = textOf(e.message.content).trim();
		if (!text) continue;
		lines.push(`[${role}] ${text}`);
	}
	let transcript = lines.join("\n\n");
	if (transcript.length > MAX_TRANSCRIPT_CHARS) {
		transcript = `[earlier conversation omitted]\n\n${transcript.slice(-MAX_TRANSCRIPT_CHARS)}`;
	}
	return transcript;
}

export default function btw(pi: any): void {
	let active: AbortController | undefined;

	function cancel() {
		active?.abort();
		active = undefined;
	}

	pi.on("session_shutdown", () => cancel());
	pi.on("session_before_switch", () => cancel());
	pi.on("session_before_fork", () => cancel());

	pi.registerCommand("btw", {
		description: "Ask a side question in parallel without touching the main session",
		argumentHint: "<question>",
		requiresArguments: false,
		handler: async (args: string, ctx: any) => {
			const question = args.trim();
			if (!question) {
				if (active) {
					cancel();
					ctx.ui.notify("/btw cancelled", "info");
				} else {
					ctx.ui.notify("Usage: /btw <question>", "warning");
				}
				return;
			}
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("/btw: no active model.", "error");
				return;
			}
			if (typeof ctx.modelRegistry?.streamSimple !== "function") {
				ctx.ui.notify("/btw: modelRegistry.streamSimple unavailable on this host.", "error");
				return;
			}

			cancel();
			const controller = new AbortController();
			active = controller;
			const timer = setTimeout(() => controller.abort(), ESTABLISHMENT_TIMEOUT_MS);

			ctx.ui.notify(`/btw: asking…`, "info");
			try {
				const transcript = buildTranscript(ctx);
				const prompt = transcript
					? `Conversation so far:\n\n${transcript}\n\nSide question: ${question}`
					: question;
				const context = {
					systemPrompt: `${ctx.getSystemPrompt?.() ?? ""}\n\n${SIDE_QUERY_INSTRUCTION}`,
					messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
					tools: [],
				};
				const stream = await ctx.modelRegistry.streamSimple(model, context, {
					signal: controller.signal,
				});
				let reply = "";
				for await (const event of stream) {
					if (event.type === "text_delta") reply += event.delta;
					else if (event.type === "error") throw new Error(event.error?.errorMessage ?? "stream error");
				}
				if (active === controller) {
					ctx.ui.notify(reply.trim() || "/btw: empty reply.", "info");
				}
			} catch (e) {
				if (active === controller && !controller.signal.aborted) {
					ctx.ui.notify(`/btw failed: ${e instanceof Error ? e.message : String(e)}`, "error");
				}
			} finally {
				clearTimeout(timer);
				if (active === controller) active = undefined;
			}
		},
	});
}
