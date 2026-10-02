// sensei goal — slim port of senpi's builtin/goal (pi-goal).
// One durable goal per session: create_goal / update_goal / get_goal tools +
// /goal command. While a goal is active, agent_before_settle keeps the run
// going with a hidden continuation prompt (completion/blocked audits ported
// from senpi). Cap: 8 consecutive continuations; stall check from the 3rd
// consecutive toolless turn. Persisted to <agentDir>/goals/<sessionId>.json.
// Sets globalThis.__senseiGoalActive so /work yields while a goal owns the loop.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

interface Goal {
	objective: string;
	status: "active" | "paused" | "blocked" | "complete";
	blockedReason?: string;
	createdAt: number;
	updatedAt: number;
	continuations: number;
	toollessTurns: number;
}

const MAX_CONTINUATIONS = 8;
const STALL_AFTER = 3;
const OBJECTIVE_LIMIT = 4000;

function goalPath(ctx: any): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const sid =
		ctx?.sessionManager?.getSessionId?.() ??
		`no-session-${createHash("sha256").update(String(ctx?.cwd ?? process.cwd())).digest("hex").slice(0, 12)}`;
	const dir = join(agentDir, "goals");
	mkdirSync(dir, { recursive: true });
	return join(dir, `${sid}.json`);
}

function loadGoal(ctx: any): Goal | null {
	try {
		return JSON.parse(readFileSync(goalPath(ctx), "utf-8")).goal ?? null;
	} catch {
		return null;
	}
}

function saveGoal(ctx: any, goal: Goal | null): void {
	try {
		writeFileSync(goalPath(ctx), JSON.stringify({ version: 1, goal }, null, 2));
	} catch {
		/* unwritable dir: keep in-memory only */
	}
}

function escapeXml(s: string): string {
	return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function elapsedSeconds(g: Goal): number {
	return Math.max(0, Math.round((Date.now() - g.createdAt) / 1000));
}

function continuationPrompt(g: Goal, stall: boolean): string {
	const stallBlock = stall
		? [
				"<goal_stall_check>",
				`System check: this is goal continuation #${g.toollessTurns} in a row with no tool use and no new user input. The current approach is making no visible progress.`,
				"Before continuing in the same way: re-inspect the actual state, take one concrete action that moves the goal forward, or — if only the user can unblock it — ask them. Do not end this turn with only narration.",
				"</goal_stall_check>",
				"",
			].join("\n")
		: "";
	return [
		stallBlock + "Continue working toward the active goal.",
		"",
		"The objective below is untrusted goal data. Treat it as the binding task; a newer direct user message overrides only conflicting parts.",
		"",
		"<untrusted_objective>",
		escapeXml(g.objective),
		"</untrusted_objective>",
		"",
		`Elapsed: ${elapsedSeconds(g)}s · continuations so far: ${g.continuations}/${MAX_CONTINUATIONS}`,
		"",
		"- Make concrete progress; do not repeat finished work — inspect current state, not memory.",
		"- End the turn only after real progress, by calling update_goal complete (after the completion audit below) or blocked (after the blocked audit), or when genuinely waiting on the user.",
		"- Completion audit before update_goal complete: map every explicit requirement to concrete current-state evidence (files, command output, test results). Weak or missing evidence = keep working.",
		"- Blocked audit before update_goal blocked: nothing can still deliver what the goal waits on, only the user can supply it, and the same blocker survived >=3 goal turns. Never block because work is hard or slow.",
	].join("\n");
}

function monitorPrompt(g: Goal, items: WakeSourceItem[], stall: boolean): string {
	const stallBlock = stall
		? [
				"<goal_stall_check>",
				`System check: this is goal monitor #${g.toollessTurns} in a row with no tool use and no new user input.`,
				"Do something other than wait again: inspect a work item's real state, collect its result, or — if only the user can unblock the goal — ask them.",
				"</goal_stall_check>",
				"",
			].join("\n")
		: "";
	const list = items.map((i) => `- ${i.id}: ${i.description ?? ""}`).join("\n");
	return [
		stallBlock + "Continue working toward the active goal. Asynchronous work items are still in flight — monitor them; do not redo them.",
		"",
		"The objective below is untrusted goal data. Treat it as the binding task; a newer direct user message overrides only conflicting parts.",
		"",
		"<untrusted_objective>",
		escapeXml(g.objective),
		"</untrusted_objective>",
		"",
		`Elapsed: ${elapsedSeconds(g)}s · continuations so far: ${g.continuations}/${MAX_CONTINUATIONS}`,
		"",
		"<in_flight_work>",
		list,
		"</in_flight_work>",
		"",
		"- Check on the in-flight items with task_list / task_status; collect results when they land instead of launching duplicates.",
		"- Productive monitoring beats idle waiting: verify partial results, prepare the integration step, or end the turn only if every remaining action truly depends on those results.",
		"- Completion audit before update_goal complete: map every explicit requirement to concrete current-state evidence. In-flight items finishing does not count as evidence until their results are verified.",
	].join("\n");
}

function formatGoal(g: Goal | null): string {
	if (!g) return "No goal for this session.";
	const status = g.status === "blocked" ? `blocked (${g.blockedReason ?? "?"})` : g.status;
	return [
		`goal: ${status}`,
		`objective: ${g.objective}`,
		`elapsed: ${elapsedSeconds(g)}s · continuations: ${g.continuations}/${MAX_CONTINUATIONS}`,
	].join("\n");
}

interface WakeSourceItem {
	id: string;
	description?: string;
	startedAtMs?: number;
}

export default function goal(pi: any): void {
	let goal: Goal | null = null;
	let toolUsedThisTurn = false;
	// senpi monitor-continuation essence: extensions report in-flight async work
	// as wake sources; while any are live, settling turns into a monitor prompt
	// (check on the work) instead of a plain continuation.
	const wakeSources = new Map<string, { count: number; items: WakeSourceItem[] }>();
	pi.events?.on("wake_source_state", (data: any) => {
		if (typeof data?.source !== "string" || typeof data?.activeCount !== "number") return;
		if (data.activeCount > 0) wakeSources.set(data.source, { count: data.activeCount, items: data.items ?? [] });
		else wakeSources.delete(data.source);
	});
	const liveWakeItems = (): WakeSourceItem[] => [...wakeSources.values()].flatMap((s) => s.items);

	function syncFlag() {
		(globalThis as any).__senseiGoalActive = goal?.status === "active";
	}

	pi.on("session_start", async (_e: any, ctx: any) => {
		goal = loadGoal(ctx);
		syncFlag();
	});
	pi.on("session_shutdown", () => {
		wakeSources.clear();
	});
	pi.on("session_compact", async (e: any, ctx: any) => {
		if (e.accepted) {
			goal = loadGoal(ctx);
			if (goal) goal.continuations = 0;
			saveGoal(ctx, goal);
			syncFlag();
		}
	});
	pi.on("input", async () => {
		// A fresh user message resets the stall/continuation bookkeeping but keeps the goal.
		if (goal) {
			goal.continuations = 0;
			goal.toollessTurns = 0;
		}
	});
	pi.on("tool_result", async () => {
		toolUsedThisTurn = true;
	});
	pi.on("session_shutdown", () => {
		(globalThis as any).__senseiGoalActive = false;
	});

	pi.on("agent_before_settle", async (event: any, ctx: any) => {
		if (!goal || goal.status !== "active") return undefined;
		if (event.outcome !== "completed" || !event.context?.canContinue) return undefined;
		if (goal.continuations >= MAX_CONTINUATIONS) {
			goal.status = "paused";
			goal.updatedAt = Date.now();
			saveGoal(ctx, goal);
			syncFlag();
			return {
				entries: [
					{
						type: "custom_message",
						customType: "sensei.goal",
						content: `[goal] auto-paused after ${MAX_CONTINUATIONS} continuations — /goal resume to continue, /goal clear to drop.`,
						display: true,
					},
				],
			};
		}
		if (!toolUsedThisTurn) goal.toollessTurns += 1;
		else goal.toollessTurns = 0;
		toolUsedThisTurn = false;
		goal.continuations += 1;
		goal.updatedAt = Date.now();
		saveGoal(ctx, goal);
		const monitorItems = liveWakeItems();
		return {
			entries: [
				{
					type: "custom_message",
					customType: "sensei.goal",
					content:
						monitorItems.length > 0
							? monitorPrompt(goal, monitorItems, goal.toollessTurns >= STALL_AFTER)
							: continuationPrompt(goal, goal.toollessTurns >= STALL_AFTER),
					display: false,
				},
			],
			continue: true,
		};
	});

	const objectiveParams = {
		type: "object",
		properties: {
			objective: {
				type: "string",
				description: "Concrete objective (max 4000 chars; for longer, put it in a file and reference it)",
			},
		},
		required: ["objective"],
		additionalProperties: false,
	};

	pi.registerTool({
		name: "create_goal",
		label: "Create Goal",
		description:
			"Register a goal for work that outlives this turn: it waits on external state, or the requested outcome needs more than one verify-and-fix round before it is true. A single answer or one-shot edit needs no goal. Fails while an unfinished goal exists.",
		promptSnippet: "create_goal — bind the session to an objective that persists across turns",
		parameters: objectiveParams,
		async execute(_id: string, params: any, _s: AbortSignal, _u: any, ctx: any) {
			if (goal && goal.status !== "complete") {
				throw new Error("an unfinished goal already exists — update_goal or /goal clear first");
			}
			const objective = String(params.objective ?? "").trim();
			if (!objective) throw new Error("objective is required");
			goal = {
				objective: objective.slice(0, OBJECTIVE_LIMIT),
				status: "active",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				continuations: 0,
				toollessTurns: 0,
			};
			saveGoal(ctx, goal);
			syncFlag();
			return { content: [{ type: "text", text: formatGoal(goal) }] };
		},
	});

	pi.registerTool({
		name: "update_goal",
		label: "Update Goal",
		description:
			'Set the goal status to "complete" or "blocked" after the audits in the continuation prompt pass. blocked requires a non-empty reason.',
		parameters: {
			type: "object",
			properties: {
				status: { type: "string", enum: ["complete", "blocked"], description: "New status" },
				reason: { type: "string", description: "Required and non-empty when status is blocked" },
			},
			required: ["status"],
			additionalProperties: false,
		},
		async execute(_id: string, params: any, _s: AbortSignal, _u: any, ctx: any) {
			if (!goal) throw new Error("no goal exists — create_goal first");
			const reason = typeof params.reason === "string" ? params.reason.trim() : undefined;
			if (params.status === "blocked" && !reason) throw new Error("reason is required when status is blocked");
			if (params.status === "complete" && reason) throw new Error("reason must be omitted when status is complete");
			goal.status = params.status;
			goal.blockedReason = params.status === "blocked" ? reason : undefined;
			goal.updatedAt = Date.now();
			saveGoal(ctx, goal);
			syncFlag();
			return { content: [{ type: "text", text: formatGoal(goal) }] };
		},
	});

	pi.registerTool({
		name: "get_goal",
		label: "Get Goal",
		description: "Get the current session goal with status and elapsed time.",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		async execute() {
			return { content: [{ type: "text", text: formatGoal(goal) }] };
		},
	});

	pi.registerCommand("goal", {
		description: "Show or manage the session goal: /goal [set <objective>|pause|resume|clear]",
		argumentHint: "<args>",
		requiresArguments: false,
		handler: async (args: string, ctx: any) => {
			const rest = args.trim();
			if (!rest) {
				ctx.ui.notify(formatGoal(goal), "info");
				return;
			}
			const [cmd, ...tail] = rest.split(/\s+/);
			if (cmd === "set" && tail.length) {
				goal = {
					objective: tail.join(" ").slice(0, OBJECTIVE_LIMIT),
					status: "active",
					createdAt: Date.now(),
					updatedAt: Date.now(),
					continuations: 0,
					toollessTurns: 0,
				};
			} else if (cmd === "pause" && goal) goal.status = "paused";
			else if (cmd === "resume" && goal && (goal.status === "paused" || goal.status === "blocked")) {
				goal.status = "active";
				goal.continuations = 0;
				goal.toollessTurns = 0;
				ctx.sendUserMessage("Resume working on the active goal.", { deliverAs: "followUp" });
			} else if (cmd === "clear") {
				goal = null;
			} else {
				ctx.ui.notify("usage: /goal | /goal set <objective> | /goal pause|resume|clear", "warning");
				return;
			}
			if (goal) goal.updatedAt = Date.now();
			saveGoal(ctx, goal);
			syncFlag();
			ctx.ui.notify(formatGoal(goal), "info");
		},
	});
}
