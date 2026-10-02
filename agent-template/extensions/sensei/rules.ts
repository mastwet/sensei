// sensei rules — slim port of senpi's builtin/rules + rule-activation.
// Discovers markdown rule files and injects them: static rules (no globs or
// alwaysApply) append to the system prompt at before_agent_start; glob rules
// activate on first matching tool result, appended to that result's content.
// Compatible with senpi/cursor frontmatter: alwaysApply, globs|paths|applyTo,
// description. Mode via SENSEI_RULES_MODE=static|dynamic|both|off (default both).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { homedir } from "node:os";

interface Rule {
	name: string;
	path: string;
	body: string;
	description?: string;
	globs: string[];
	always: boolean;
	activated: boolean;
}

const PROJECT_MARKERS = [".git", "pnpm-workspace.yaml", "package.json", "pyproject.toml", "Cargo.toml", "go.mod"];
const PROJECT_RULE_SUBDIRS: [string, string][] = [
	[".sensei", "rules"],
	[".pi", "rules"],
	[".omo", "rules"],
	[".claude", "rules"],
	[".cursor", "rules"],
	[".github", "instructions"],
];
const PROJECT_SINGLE_FILES = [".github/copilot-instructions.md"];
// AGENTS.md / CLAUDE.md / CONTEXT.md are intentionally absent: pi loads them natively.
const RULE_EXTENSIONS = [".md", ".mdc"];
const MAX_RULE_BYTES = 32 * 1024;

function mode(): string {
	return (process.env.SENSEI_RULES_MODE ?? "both").toLowerCase();
}

function globToRegExp(glob: string): RegExp {
	let re = "";
	let i = 0;
	while (i < glob.length) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				if (glob[i + 2] === "/") {
					re += "(?:.*/)?";
					i += 3;
				} else {
					re += ".*";
					i += 2;
				}
			} else {
				re += "[^/]*";
				i += 1;
			}
		} else if (c === "?") {
			re += "[^/]";
			i += 1;
		} else {
			re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
			i += 1;
		}
	}
	return new RegExp(`^${re}$`);
}

interface CompiledGlob {
	source: string;
	re: RegExp;
}

let compiled = new Map<string, RegExp>();
function matchGlob(globs: string[], relPath: string): boolean {
	const normalized = relPath.split(sep).join("/").replace(/^\.\//, "");
	for (const g of globs) {
		let re = compiled.get(g);
		if (!re) {
			re = globToRegExp(g);
			compiled.set(g, re);
		}
		if (re.test(normalized)) return true;
	}
	return false;
}

function parseFrontmatter(content: string): { fm: Record<string, any>; body: string } {
	const text = content.replace(/\r\n/g, "\n");
	if (!text.startsWith("---\n")) return { fm: {}, body: text };
	const end = text.indexOf("\n---", 4);
	if (end === -1) return { fm: {}, body: text };
	const fm: Record<string, any> = {};
	for (const line of text.slice(4, end).split("\n")) {
		const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
		if (!m) continue;
		const [, key, raw] = m;
		const value = raw.trim();
		if (key === "alwaysApply") fm.alwaysApply = /^(true|yes|1)$/i.test(value);
		else if (key === "description") fm.description = value.replace(/^["']|["']$/g, "");
		else if (key === "globs" || key === "paths" || key === "applyTo") {
			const items = value.startsWith("[")
				? value.slice(1, value.lastIndexOf("]")).split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""))
				: value.split(",").map((s) => s.trim());
			fm.globs = [...(fm.globs ?? []), ...items.filter(Boolean)];
		}
	}
	return { fm, body: text.slice(end + 4).replace(/^\n+/, "") };
}

function findProjectRoot(cwd: string): string {
	let dir = resolve(cwd);
	for (;;) {
		if (PROJECT_MARKERS.some((m) => existsSync(join(dir, m)))) return dir;
		const parent = resolve(dir, "..");
		if (parent === dir) return resolve(cwd);
		dir = parent;
	}
}

function scanDir(dir: string, out: Rule[]): void {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		const p = join(dir, name);
		if (RULE_EXTENSIONS.some((ext) => name.endsWith(ext))) {
			loadRuleFile(p, out);
		} else {
			try {
				if (readdirSync(p)) scanDir(p, out);
			} catch {
				continue;
			}
		}
	}
}

function loadRuleFile(path: string, out: Rule[]): void {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return;
	}
	if (raw.length > MAX_RULE_BYTES) raw = `${raw.slice(0, MAX_RULE_BYTES)}\n\n[rule truncated]`;
	const { fm, body } = parseFrontmatter(raw);
	out.push({
		name: basename(path).replace(/\.(md|mdc)$/, ""),
		path,
		body: body.trim(),
		description: fm.description,
		globs: fm.globs ?? [],
		always: fm.alwaysApply === true,
		activated: false,
	});
}

function discoverRules(cwd: string): Rule[] {
	const out: Rule[] = [];
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	scanDir(join(agentDir, "rules"), out);
	scanDir(join(homedir(), ".sensei", "rules"), out);
	const root = findProjectRoot(cwd);
	for (const [parent, sub] of PROJECT_RULE_SUBDIRS) scanDir(join(root, parent, sub), out);
	for (const file of PROJECT_SINGLE_FILES) {
		const p = join(root, file);
		if (existsSync(p)) loadRuleFile(p, out);
	}
	return out;
}

// Pull candidate file paths out of a tool_result event's input.
function extractPaths(input: Record<string, unknown>, cwd: string): string[] {
	const paths: string[] = [];
	for (const key of ["path", "file", "filePath", "file_path", "pattern", "glob"]) {
		const v = input[key];
		if (typeof v === "string" && v) paths.push(v);
	}
	const command = typeof input.command === "string" ? input.command : "";
	for (const tok of command.split(/\s+/)) {
		if (/[/\\]|\.[a-zA-Z0-9]{1,8}$/.test(tok) && !tok.startsWith("-")) paths.push(tok);
	}
	return paths.map((p) => (p.startsWith("/") ? p : join(cwd, p)));
}

export default function rules(pi: any): void {
	let rulesList: Rule[] = [];
	let projectRoot = "";

	function rescan(cwd: string): void {
		compiled = new Map();
		projectRoot = findProjectRoot(cwd);
		rulesList = discoverRules(cwd);
	}

	function staticRules(): Rule[] {
		if (mode() === "off" || mode() === "dynamic") return [];
		return rulesList.filter((r) => r.always || r.globs.length === 0);
	}

	function dynamicRules(): Rule[] {
		if (mode() === "off" || mode() === "static") return [];
		return rulesList.filter((r) => !r.always && r.globs.length > 0);
	}

	pi.on("session_start", async (_e: any, ctx: any) => rescan(ctx.cwd ?? process.cwd()));
	pi.on("session_compact", async (e: any, ctx: any) => {
		if (e.accepted) rescan(ctx.cwd ?? process.cwd());
	});

	pi.on("before_agent_start", async (event: any) => {
		const rulesToInject = staticRules().filter((r) => r.body);
		if (!rulesToInject.length) return undefined;
		const block = rulesToInject
			.map((r) => `<rule name="${r.name}" source="${r.path}">\n${r.body}\n</rule>`)
			.join("\n\n");
		return { systemPrompt: `${event.systemPrompt}\n\n# Rules\n\n${block}` };
	});

	pi.on("tool_result", async (event: any, ctx: any) => {
		const pending = dynamicRules().filter((r) => !r.activated);
		if (!pending.length) return undefined;
		const paths = extractPaths(event.input ?? {}, ctx.cwd ?? projectRoot);
		if (!paths.length) return undefined;
		const relPaths = paths.map((p) =>
			p.startsWith(projectRoot + sep) ? p.slice(projectRoot.length + 1) : p,
		);
		const matched = pending.filter((r) =>
			relPaths.some((rp) => matchGlob(r.globs, rp.split(sep).join("/"))),
		);
		if (!matched.length) return undefined;
		for (const r of matched) r.activated = true;
		const block = matched
			.map((r) => `<rule_activated name="${r.name}" source="${r.path}">\n${r.body}\n</rule_activated>`)
			.join("\n\n");
		if (Array.isArray(event.content)) {
			event.content.push({ type: "text", text: `\n\n${block}` });
		}
		return undefined;
	});

	pi.registerCommand("rules", {
		description: "List discovered rules; /rules reload rescans",
		handler: async (args: string, ctx: any) => {
			if (args.trim() === "reload") {
				rescan(ctx.cwd ?? process.cwd());
				ctx.ui.notify(`rules reloaded: ${rulesList.length} rule(s)`, "info");
				return;
			}
			if (!rulesList.length) {
				ctx.ui.notify("No rules discovered (mode: " + mode() + ")", "info");
				return;
			}
			const lines = rulesList.map((r) => {
				const kind = r.always || !r.globs.length ? "static" : `glob:${r.globs.join(",")}`;
				const state = r.activated ? "activated" : kind;
				return `- ${r.name} [${state}] ${r.path}`;
			});
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
