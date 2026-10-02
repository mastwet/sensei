// sensei history-search — slim port of senpi's builtin/history-search.
// `history_search` tool + /history command: fuzzy-search user prompts across
// all sessions under the agent sessions dir. No TUI overlay (dep-free).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

interface HistoryEntry {
	text: string;
	sessionId: string;
	sessionFile: string;
	cwd: string;
	timestamp: number;
}

const MAX_FILES = 500;
const DAY_MS = 86_400_000;
const RECENCY_WEIGHT = 0.01;

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

function indexSessions(sessionsRoot: string): HistoryEntry[] {
	const files: { path: string; mtime: number }[] = [];
	const walk = (dir: string, depth: number) => {
		if (depth > 3 || files.length >= MAX_FILES) return;
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			if (files.length >= MAX_FILES) return;
			const p = join(dir, name);
			try {
				const st = statSync(p);
				if (st.isDirectory()) walk(p, depth + 1);
				else if (name.endsWith(".jsonl")) files.push({ path: p, mtime: st.mtimeMs });
			} catch {
				continue;
			}
		}
	};
	walk(sessionsRoot, 0);
	files.sort((a, b) => b.mtime - a.mtime);

	const entries: HistoryEntry[] = [];
	for (const file of files) {
		let lines: string[];
		try {
			lines = readFileSync(file.path, "utf-8").split("\n");
		} catch {
			continue;
		}
		let sessionId = "";
		let cwd = "";
		for (const line of lines) {
			if (!line.startsWith("{")) continue;
			let rec: any;
			try {
				rec = JSON.parse(line);
			} catch {
				continue;
			}
			if (rec.type === "session") {
				sessionId = String(rec.id ?? "");
				cwd = String(rec.cwd ?? "");
				continue;
			}
			if (rec.type !== "message" || rec.message?.role !== "user") continue;
			const text = textOf(rec.message.content).trim();
			if (!text || text.startsWith("<")) continue;
			entries.push({
				text,
				sessionId,
				sessionFile: file.path,
				cwd,
				timestamp: Date.parse(rec.timestamp ?? "") || file.mtime,
			});
		}
	}
	return entries;
}

// Subsequence fuzzy match with a simple score (lower = better).
function fuzzyScore(query: string, text: string): number | null {
	const q = query.toLowerCase();
	const t = text.toLowerCase();
	let ti = 0;
	let score = 0;
	for (let qi = 0; qi < q.length; qi++) {
		const ch = q[qi];
		const found = t.indexOf(ch, ti);
		if (found === -1) return null;
		score += found - ti;
		ti = found + 1;
	}
	return score;
}

function filterHistory(entries: HistoryEntry[], query: string): HistoryEntry[] {
	const q = query.trim();
	if (!q) return entries.slice(0, 50);
	let newest = 0;
	for (const e of entries) newest = Math.max(newest, e.timestamp);
	const scored: { entry: HistoryEntry; score: number }[] = [];
	for (const entry of entries) {
		const s = fuzzyScore(q, entry.text);
		if (s === null) continue;
		const ageDays = Math.max(0, newest - entry.timestamp) / DAY_MS;
		scored.push({ entry, score: s + ageDays * RECENCY_WEIGHT });
	}
	scored.sort((a, b) => a.score - b.score || b.entry.timestamp - a.entry.timestamp);
	return scored.map((s) => s.entry);
}

function sessionsRoot(ctx: any): string {
	const sessionDir = ctx.sessionManager?.getSessionDir?.() ?? "";
	// Session files live in <agentDir>/sessions/<project-dir-slug>/file.jsonl —
	// searching the project dir's parent covers every project.
	return sessionDir ? resolve(sessionDir, "..") : resolve(process.env.PI_CODING_AGENT_DIR ?? "", "sessions");
}

function formatMatch(e: HistoryEntry): string {
	const when = new Date(e.timestamp).toISOString().slice(0, 16).replace("T", " ");
	const oneLine = e.text.replace(/\s+/g, " ").slice(0, 120);
	return `${when} ${e.cwd || "?"} — ${oneLine}`;
}

export default function historySearch(pi: any): void {
	pi.registerTool({
		name: "history_search",
		label: "History Search",
		description:
			"Fuzzy-search user prompts across all past pi sessions on this machine. Use when the user references earlier work, a previous conversation, or a prompt they wrote before. Returns the most relevant prompts with their session cwd and timestamp.",
		promptSnippet: "history_search <query> — find prompts from earlier sessions",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "Search query (fuzzy, subsequence match)" },
				limit: { type: "number", description: "Max matches (default 10)" },
			},
			required: ["query"],
			additionalProperties: false,
		},
		async execute(_id: string, params: any, _signal: AbortSignal, _onUpdate: any, ctx: any) {
			const entries = indexSessions(sessionsRoot(ctx));
			if (entries.length === 0) {
				return { content: [{ type: "text", text: "No prompt history found." }] };
			}
			const matches = filterHistory(entries, params.query).slice(0, params.limit ?? 10);
			const text = matches.length
				? matches.map(formatMatch).join("\n")
				: `No matches for "${params.query}".`;
			return { content: [{ type: "text", text }], details: { total: entries.length, shown: matches.length } };
		},
	});

	pi.registerCommand("history", {
		description: "Search prompt history across sessions",
		argumentHint: "<query>",
		handler: async (args: string, ctx: any) => {
			const entries = indexSessions(sessionsRoot(ctx));
			const matches = filterHistory(entries, args).slice(0, 15);
			if (!matches.length) {
				ctx.ui.notify(entries.length ? `No matches for "${args}".` : "No prompt history found.", "info");
				return;
			}
			ctx.ui.notify(matches.map(formatMatch).join("\n"), "info");
		},
	});
}
