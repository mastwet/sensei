// sensei preset — slim port of senpi's builtin/prompt-preset.
// Named system-prompt fragments from <agentDir>/presets/*.md and
// <project>/.sensei/presets/*.md. /preset <name> selects one for the session;
// its content is appended to the system prompt on each before_agent_start.
// SENSEI_PRESET=<name> preselects. Append-only by design — presets extend the
// host prompt instead of replacing it, so tool guidance can't be clobbered.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";

interface Preset {
	name: string;
	path: string;
	content: string;
}

function presetDirs(cwd: string): string[] {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const dirs = [join(agentDir, "presets")];
	let dir = resolve(cwd);
	for (;;) {
		if (existsSync(join(dir, ".git")) || existsSync(join(dir, "package.json"))) {
			dirs.push(join(dir, ".sensei", "presets"));
			break;
		}
		const parent = resolve(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}
	return dirs;
}

function loadPresets(cwd: string): Preset[] {
	const out: Preset[] = [];
	for (const dir of presetDirs(cwd)) {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.endsWith(".md")) continue;
			try {
				const path = join(dir, name);
				out.push({
					name: basename(name, ".md"),
					path,
					content: readFileSync(path, "utf-8").trim(),
				});
			} catch {
				continue;
			}
		}
	}
	return out;
}

export default function preset(pi: any): void {
	let presets: Preset[] = [];
	let active: Preset | undefined;

	pi.on("session_start", async (_e: any, ctx: any) => {
		presets = loadPresets(ctx.cwd ?? process.cwd());
		const wanted = process.env.SENSEI_PRESET;
		active = wanted ? presets.find((p) => p.name === wanted) : undefined;
		if (wanted && !active) {
			ctx.ui.notify(
				`SENSEI_PRESET "${wanted}" not found. Available: ${presets.map((p) => p.name).join(", ") || "(none)"}`,
				"warning",
			);
		}
	});

	pi.on("before_agent_start", async (event: any) => {
		if (!active?.content) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n# Preset: ${active.name}\n\n${active.content}` };
	});

	pi.registerCommand("preset", {
		description: "Select a system-prompt preset: /preset [name|off]",
		argumentHint: "<name|off>",
		requiresArguments: false,
		handler: async (args: string, ctx: any) => {
			const name = args.trim();
			if (!name) {
				const list = presets.map((p) => `${p.name === active?.name ? "*" : " "} ${p.name}  ${p.path}`);
				ctx.ui.notify(
					presets.length
						? `presets (${active ? `active: ${active.name}` : "none active"}):\n${list.join("\n")}`
						: `No presets. Drop .md files in ${presetDirs(ctx.cwd ?? process.cwd()).join(" or ")}`,
					"info",
				);
				return;
			}
			if (name === "off") {
				active = undefined;
				ctx.ui.notify("preset cleared", "info");
				return;
			}
			const found = presets.find((p) => p.name === name);
			if (!found) {
				ctx.ui.notify(
					`preset "${name}" not found. Available: ${presets.map((p) => p.name).join(", ") || "(none)"}`,
					"error",
				);
				return;
			}
			active = found;
			ctx.ui.notify(`preset "${name}" active (applies from next turn)`, "info");
		},
	});
}
