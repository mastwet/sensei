// sensei look-at — slim port of senpi's builtin/look-at.
// `look_at` tool: delegates media analysis to a vision-capable model via
// ctx.modelRegistry.streamSimple. Tool is only activated while the active
// model lacks image input and a vision model is resolvable.
// Vision chain: SENSEI_VISION_MODEL env ("provider/id") -> first available
// model whose input includes "image".

import { readFileSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

const TOOL_NAME = "look_at";
const MAX_FILES = 6;
const MAX_BYTES_PER_FILE = 8 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

const MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".svg": "image/svg+xml",
	".pdf": "application/pdf",
};

const LOOK_AT_SYSTEM_PROMPT = `You analyze attached media for a downstream agent that cannot inspect the attachments directly.

Extract only the information requested by the goal. Match the language of the goal.

Evidence rules:
- Be evidence-first. Clearly separate direct observations from inferences, and label inferences as such.
- Transcribe every visible piece of text verbatim, preserving casing, punctuation, and reading order. Mark unreadable text explicitly rather than guessing.
- Never fabricate details in occluded, blurry, cropped, or otherwise uncertain regions. State that the detail is unavailable or uncertain.
- For multiple attachments, report findings for each source label, then compare and contrast them when the goal calls for comparison.
- Be thorough about the goal and concise about unrelated detail.

Return only the response body. Do not add a preamble, meta commentary, or postscript.`;

function resolveVisionModel(ctx: any): any {
	const registry = ctx.modelRegistry;
	if (!registry) return undefined;
	const pinned = process.env.SENSEI_VISION_MODEL;
	if (pinned) {
		const slash = pinned.indexOf("/");
		const found = slash > 0 ? registry.find?.(pinned.slice(0, slash), pinned.slice(slash + 1)) : undefined;
		if (found) return found;
	}
	for (const model of registry.getAvailable?.() ?? []) {
		if (Array.isArray(model.input) && model.input.includes("image")) return model;
	}
	return undefined;
}

function loadImages(paths: string[], cwd: string): { content: any[]; labels: string[]; mimeTypes: string[] } {
	const content: any[] = [];
	const labels: string[] = [];
	const mimeTypes: string[] = [];
	for (const raw of paths.slice(0, MAX_FILES)) {
		const p = resolve(cwd, raw);
		const mime = MIME_BY_EXT[extname(p).toLowerCase()];
		if (!mime) throw new Error(`unsupported media type: ${raw} (supported: images, pdf)`);
		const st = statSync(p);
		if (st.size > MAX_BYTES_PER_FILE) throw new Error(`${raw}: exceeds ${MAX_BYTES_PER_FILE} bytes`);
		const data = readFileSync(p).toString("base64");
		content.push({ type: "image", data, mimeType: mime });
		labels.push(basename(p));
		mimeTypes.push(mime);
	}
	return { content, labels, mimeTypes };
}

export default function lookAt(pi: any): void {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Look At",
		description:
			"Extract basic information from media files such as PDFs, images, and diagrams when a quick summary is sufficient. Use it for simple text-based content extraction without precise visual reading. Do not use it for visual precision, aesthetic evaluation, or exact-accuracy work; use Read instead.",
		promptSnippet:
			"Extract a quick summary or basic information from attached media; use Read instead when visual precision or exact accuracy matters.",
		parameters: {
			type: "object",
			properties: {
				goal: { type: "string", description: "What to extract from the media" },
				paths: {
					type: "array",
					items: { type: "string" },
					description: "Media file paths (images or pdf, max 6)",
				},
			},
			required: ["goal", "paths"],
			additionalProperties: false,
		},
		async execute(_id: string, params: any, signal: AbortSignal, _onUpdate: any, ctx: any) {
			const paths = Array.isArray(params.paths) ? params.paths.filter((p: any) => typeof p === "string") : [];
			if (!paths.length) throw new Error("look_at requires at least one path");
			const model = resolveVisionModel(ctx);
			if (!model) {
				throw new Error(
					"No image-capable model available. Configure a vision provider or set SENSEI_VISION_MODEL=provider/id.",
				);
			}
			const { content, labels, mimeTypes } = loadImages(paths, ctx.cwd ?? process.cwd());
			content.push({
				type: "text",
				text: `Goal:\n${params.goal}\n\nAttached sources:\n${labels.map((l) => `- ${l}`).join("\n")}`,
			});

			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
			const onAbort = () => controller.abort();
			signal?.addEventListener?.("abort", onAbort);
			try {
				const stream = await ctx.modelRegistry.streamSimple(
					model,
					{
						systemPrompt: LOOK_AT_SYSTEM_PROMPT,
						messages: [{ role: "user", content, timestamp: Date.now() }],
						tools: [],
					},
					{ signal: controller.signal },
				);
				let text = "";
				for await (const event of stream) {
					if (event.type === "text_delta") text += event.delta;
					else if (event.type === "error") throw new Error(event.error?.errorMessage ?? "stream error");
				}
				return {
					content: [{ type: "text", text: text.trim() || "(empty analysis)" }],
					details: { model: `${model.provider}/${model.id}`, sources: labels, mimeTypes },
				};
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener?.("abort", onAbort);
			}
		},
	});

	function syncToolActivation(ctx: any) {
		const active: string[] = pi.getActiveTools?.() ?? [];
		const shouldBeActive =
			ctx.model !== undefined &&
			!ctx.model.input?.includes?.("image") &&
			resolveVisionModel(ctx) !== undefined;
		const isActive = active.includes(TOOL_NAME);
		if (shouldBeActive && !isActive) {
			pi.setActiveTools([...active, TOOL_NAME]);
		} else if (!shouldBeActive && isActive) {
			pi.setActiveTools(active.filter((n: string) => n !== TOOL_NAME));
		}
	}

	pi.on("session_start", async (_e: any, ctx: any) => syncToolActivation(ctx));
	pi.on("model_select", async (_e: any, ctx: any) => syncToolActivation(ctx));
}
