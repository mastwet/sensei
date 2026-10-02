// sensei loop — slim port of senpi's builtin/loop + schedule.
// Durable per-session jobs: `loop` tool + /loop command. A job re-injects a
// prompt every N minutes (or daily at HH:MM), optionally a fixed number of
// times. Jobs persist to <agentDir>/loops/<sessionId>.json and resume on
// session_start; timers only run in interactive (tui) mode — headless runs
// fire due jobs at the settle boundary instead.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

interface Job {
	id: string;
	task: string;
	everyMinutes?: number;
	atTime?: string; // HH:MM daily
	nextRunAt: number; // epoch ms
	timesLeft: number; // -1 = unlimited
	createdAt: number;
}

const TICK_MS = 15_000;
const MAX_JOBS = 20;

function jobsPath(ctx: any): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const sid =
		ctx?.sessionManager?.getSessionId?.() ??
		`no-session-${createHash("sha256").update(String(ctx?.cwd ?? process.cwd())).digest("hex").slice(0, 12)}`;
	const dir = join(agentDir, "loops");
	mkdirSync(dir, { recursive: true });
	return join(dir, `${sid}.json`);
}

function loadJobs(ctx: any): Job[] {
	try {
		const data = JSON.parse(readFileSync(jobsPath(ctx), "utf-8"));
		return Array.isArray(data.jobs) ? data.jobs : [];
	} catch {
		return [];
	}
}

function saveJobs(ctx: any, jobs: Job[]): void {
	const path = jobsPath(ctx);
	if (!jobs.length) {
		try {
			writeFileSync(path, JSON.stringify({ version: 1, jobs: [] }));
		} catch {}
		return;
	}
	writeFileSync(path, JSON.stringify({ version: 1, jobs }, null, 2));
}

function computeNext(job: Job, from: number): number {
	if (job.everyMinutes) return from + job.everyMinutes * 60_000;
	if (job.atTime) {
		const [h, m] = job.atTime.split(":").map(Number);
		const next = new Date(from);
		next.setHours(h, m, 0, 0);
		if (next.getTime() <= from) next.setDate(next.getDate() + 1);
		return next.getTime();
	}
	return from;
}

function renderJobs(jobs: Job[]): string {
	if (!jobs.length) return "No loop jobs.";
	return jobs
		.map((j) => {
			const sched = j.everyMinutes ? `every ${j.everyMinutes}m` : `daily ${j.atTime}`;
			const times = j.timesLeft === -1 ? "∞" : `${j.timesLeft} left`;
			return `- ${j.id} [${sched}, ${times}, next ${new Date(j.nextRunAt).toLocaleTimeString()}] ${j.task}`;
		})
		.join("\n");
}

export default function loop(pi: any): void {
	let jobs: Job[] = [];
	let timer: ReturnType<typeof setInterval> | undefined;
	let ctxRef: any;

	function persist(ctx: any) {
		try {
			saveJobs(ctx, jobs);
		} catch {
			/* no-session dirs may be unwritable */
		}
	}

	function dueJobs(now: number): Job[] {
		return jobs.filter((j) => j.nextRunAt <= now);
	}

	function fire(ctx: any, job: Job) {
		job.timesLeft = job.timesLeft === -1 ? -1 : job.timesLeft - 1;
		job.nextRunAt = computeNext(job, Date.now());
		ctx.sendUserMessage(`[loop ${job.id}] ${job.task}`, { deliverAs: "followUp" });
	}

	function sweep(ctx: any) {
		const now = Date.now();
		const due = dueJobs(now);
		if (!due.length) return;
		for (const job of due) fire(ctx, job);
		jobs = jobs.filter((j) => j.timesLeft !== 0);
		persist(ctx);
	}

	function arm(ctx: any) {
		disarm();
		if (ctx.mode !== "tui") return;
		timer = setInterval(() => sweep(ctxRef), TICK_MS);
		timer.unref?.();
	}

	function disarm() {
		if (timer) clearInterval(timer);
		timer = undefined;
	}

	pi.on("session_start", async (_e: any, ctx: any) => {
		ctxRef = ctx;
		jobs = loadJobs(ctx);
		sweep(ctx); // catch up on jobs that came due while the session was closed
		arm(ctx);
	});

	pi.on("session_shutdown", () => disarm());
	pi.on("session_before_switch", () => disarm());
	pi.on("session_before_fork", () => disarm());

	// In headless mode timers never run; catch due jobs at the settle boundary.
	pi.on("agent_before_settle", async (event: any, ctx: any) => {
		if (ctx.mode === "tui") return undefined;
		const due = dueJobs(Date.now());
		if (!due.length || !event.context?.canContinue) return undefined;
		const entries = due.map((job: Job) => {
			job.timesLeft = job.timesLeft === -1 ? -1 : job.timesLeft - 1;
			job.nextRunAt = computeNext(job, Date.now());
			return {
				type: "custom_message",
				customType: "sensei.loop",
				content: `[loop ${job.id}] ${job.task}`,
				display: false,
			};
		});
		jobs = jobs.filter((j) => j.timesLeft !== 0);
		persist(ctx);
		return { entries, continue: true };
	});

	function addJob(params: any): Job {
		const every = params.everyMinutes ? Number(params.everyMinutes) : undefined;
		const at = typeof params.at === "string" && /^\d{1,2}:\d{2}$/.test(params.at) ? params.at : undefined;
		if (!every && !at) throw new Error("loop add requires everyMinutes or at (HH:MM)");
		if (every && (!Number.isFinite(every) || every < 1)) throw new Error("everyMinutes must be >= 1");
		const job: Job = {
			id: params.id ? String(params.id) : `job-${Date.now().toString(36)}`,
			task: String(params.task ?? "").trim(),
			everyMinutes: every,
			atTime: at,
			nextRunAt: 0,
			timesLeft: params.times ? Math.max(1, Number(params.times)) : -1,
			createdAt: Date.now(),
		};
		if (!job.task) throw new Error("loop add requires a non-empty task");
		job.nextRunAt = computeNext(job, Date.now());
		jobs = jobs.filter((j) => j.id !== job.id);
		if (jobs.length >= MAX_JOBS) throw new Error(`loop limit reached (${MAX_JOBS} jobs)`);
		jobs.push(job);
		return job;
	}

	pi.registerTool({
		name: "loop",
		label: "Loop",
		description:
			"Schedule a prompt to be re-injected on an interval (everyMinutes) or daily at a time (at: HH:MM), optionally a fixed number of times. Use for recurring checks, monitoring, or periodic work the user asks to repeat. Jobs persist per session.",
		promptSnippet: "loop add — schedule a recurring prompt (everyMinutes or at HH:MM)",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["add", "list", "remove", "clear"], description: "Operation" },
				task: { type: "string", description: "Prompt to inject when the job fires (add)" },
				everyMinutes: { type: "number", description: "Interval in minutes (add)" },
				at: { type: "string", description: "Daily time HH:MM (add)" },
				times: { type: "number", description: "Max fires; omit for unlimited (add)" },
				id: { type: "string", description: "Job id (add to overwrite, remove to delete)" },
			},
			required: ["action"],
			additionalProperties: false,
		},
		async execute(_id: string, params: any, _s: AbortSignal, _u: any, ctx: any) {
			switch (params.action) {
				case "add": {
					const job = addJob(params);
					persist(ctx);
					return {
						content: [{ type: "text", text: `loop job ${job.id} scheduled — ${renderJobs([job])}` }],
						details: { job },
					};
				}
				case "list":
					return { content: [{ type: "text", text: renderJobs(jobs) }], details: { count: jobs.length } };
				case "remove": {
					const before = jobs.length;
					jobs = jobs.filter((j) => j.id !== params.id);
					persist(ctx);
					if (jobs.length === before) throw new Error(`no loop job "${params.id}"`);
					return { content: [{ type: "text", text: `removed ${params.id}` }] };
				}
				case "clear":
					jobs = [];
					persist(ctx);
					return { content: [{ type: "text", text: "all loop jobs cleared" }] };
				default:
					throw new Error(`unknown loop action "${params.action}"`);
			}
		},
	});

	pi.registerCommand("loop", {
		description: "Manage loop jobs: /loop [list|remove <id>|clear|every <m> <task>|at HH:MM <task>]",
		argumentHint: "<args>",
		requiresArguments: false,
		handler: async (args: string, ctx: any) => {
			const parts = args.trim().split(/\s+/);
			if (!parts[0] || parts[0] === "list") {
				ctx.ui.notify(renderJobs(jobs), "info");
				return;
			}
			try {
				if (parts[0] === "remove") {
					const before = jobs.length;
					jobs = jobs.filter((j) => j.id !== parts[1]);
					persist(ctx);
					ctx.ui.notify(jobs.length === before ? `no loop job "${parts[1]}"` : `removed ${parts[1]}`, "info");
				} else if (parts[0] === "clear") {
					jobs = [];
					persist(ctx);
					ctx.ui.notify("all loop jobs cleared", "info");
				} else if (parts[0] === "every" && parts.length >= 3) {
					const job = addJob({ everyMinutes: Number(parts[1]), task: parts.slice(2).join(" ") });
					persist(ctx);
					ctx.ui.notify(`loop job ${job.id} scheduled — every ${job.everyMinutes}m`, "info");
				} else if (parts[0] === "at" && parts.length >= 3) {
					const job = addJob({ at: parts[1], task: parts.slice(2).join(" ") });
					persist(ctx);
					ctx.ui.notify(`loop job ${job.id} scheduled — daily ${job.atTime}`, "info");
				} else {
					ctx.ui.notify("usage: /loop list | /loop every <minutes> <task> | /loop at HH:MM <task> | /loop remove <id> | /loop clear", "warning");
				}
			} catch (e) {
				ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
			}
		},
	});
}
