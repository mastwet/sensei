// delegate — run a self-contained subtask in a fresh headless pi subprocess.
// Replaces heavyweight multi-agent orchestration: one tool, real isolation,
// no shared state, depth-capped.
//   delegate(task, role?)          — blocking subagent, optional specialist role
//   delegate(task, background=true)— returns a task id immediately; the result
//                                    is injected as a message when it settles
//   task_list/status/cancel/revive/send — manage background delegates
//
// Task-manager essence (port of omo-slim task-session-manager, reduced):
// every background task is persisted under <agent-dir>/tasks/<id>.json with its
// JSONL output stream at <id>.output.jsonl, so tasks survive the parent session.
// On session_start, orphans are reaped: a dead pid with a finished output file
// is finalized and its result injected once; a dead pid without output is marked
// failed; a live pid is marked "orphaned" (task_revive respawns it).
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ROLES } from "./roles.ts";

const MAX_DEPTH = 2;
const DEFAULT_TIMEOUT_S = 900;
const MAX_OUTPUT_CHARS = 30000;
const MAX_TASKS = 32;

interface DelegateResult {
  text: string;
  truncated: boolean;
  exitCode: number | null;
  timedOut: boolean;
}

type TaskStatus = "running" | "done" | "failed" | "cancelled" | "orphaned";

// Fields persisted to <agent-dir>/tasks/<id>.json.
interface BgTask {
  id: string;
  task: string;
  role?: string;
  model?: string;
  cwd: string;
  timeoutS: number;
  status: TaskStatus;
  pid?: number;
  startedAt: number;
  endedAt?: number;
  result?: DelegateResult;
  reported: boolean;
  notes: string[];
  child?: ChildProcess; // runtime-only
}

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".sensei");
const TASKS_DIR = join(AGENT_DIR, "tasks");

const taskJsonPath = (id: string) => join(TASKS_DIR, `${id}.json`);
const taskOutPath = (id: string) => join(TASKS_DIR, `${id}.output.jsonl`);

function persist(t: BgTask): void {
  try {
    mkdirSync(TASKS_DIR, { recursive: true });
    const { child, ...record } = t;
    writeFileSync(taskJsonPath(t.id), JSON.stringify(record, null, 2));
  } catch {}
}

function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function extractFinalText(jsonl: string): string {
  let text = "";
  for (const line of jsonl.split("\n")) {
    if (!line.startsWith("{")) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type === "message_end" && rec.message?.role === "assistant") {
      const parts = (rec.message.content ?? [])
        .filter((c: any) => c?.type === "text")
        .map((c: any) => c.text);
      if (parts.length) text = parts.join("\n");
    }
  }
  return text;
}

// A task's output stream is terminal once the agent loop ended or the child
// emitted an error/end marker — used when reaping orphans after a restart.
function outputIsTerminal(jsonl: string): boolean {
  return /"type":"agent_end"|"type":"agent_settled"|"type":"session_shutdown"/.test(jsonl);
}

// User overrides: <agent-dir>/roles/<role>.md fully replaces the bundled
// prompt; <role>_append.md is appended. The agent dir is user-owned and never
// re-synced, unlike extensions/.
function resolveRolePrompt(roleName: string, bundled: string): string {
  const replacePath = join(AGENT_DIR, "roles", `${roleName}.md`);
  const appendPath = join(AGENT_DIR, "roles", `${roleName}_append.md`);
  let prompt = bundled;
  try {
    if (existsSync(replacePath)) prompt = readFileSync(replacePath, "utf8");
  } catch {}
  try {
    if (existsSync(appendPath)) prompt = `${prompt}\n\n${readFileSync(appendPath, "utf8")}`;
  } catch {}
  return prompt;
}

function buildArgs(piBin: string, params: any): string[] {
  const args = [piBin, "-p", "--mode", "json", "--no-session"];
  const role = params.role ? ROLES[params.role] : undefined;
  if (role) {
    args.push("--system-prompt", resolveRolePrompt(params.role, role.prompt));
    if (role.tools) args.push("--tools", role.tools);
    if (role.excludeTools) args.push("--exclude-tools", role.excludeTools);
  }
  if (params.model) args.push("--model", params.model);
  args.push(params.task);
  return args;
}

function spawnDelegate(piBin: string, args: string[], cwd: string, outPath?: string): {
  child: ChildProcess;
  done: Promise<DelegateResult>;
} {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, SENSEI_DELEGATE_DEPTH: String(Number(process.env.SENSEI_DELEGATE_DEPTH ?? "0") + 1) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const outStream = outPath ? createWriteStream(outPath) : undefined;
  child.stdout?.on("data", (d) => {
    stdout += d;
    outStream?.write(d);
  });
  child.stderr?.on("data", (d) => (stderr += d));
  const done = new Promise<DelegateResult>((resolve) => {
    child.on("close", (code) => {
      outStream?.end();
      let text = extractFinalText(stdout);
      if (!text && stderr) text = `(no assistant output) stderr: ${stderr.slice(-2000)}`;
      const truncated = text.length > MAX_OUTPUT_CHARS;
      resolve({ text: truncated ? text.slice(0, MAX_OUTPUT_CHARS) : text, truncated, exitCode: code, timedOut: false });
    });
    child.on("error", (e) => {
      outStream?.end();
      resolve({ text: `delegate spawn failed: ${e.message}`, truncated: false, exitCode: null, timedOut: false });
    });
  });
  return { child, done };
}

function formatResult(res: DelegateResult, timeoutS: number): string {
  const note = res.timedOut ? `\n\n[delegate: killed after ${timeoutS}s timeout]` : "";
  const trunc = res.truncated ? `\n\n[delegate: output truncated at ${MAX_OUTPUT_CHARS} chars]` : "";
  return res.text + note + trunc;
}

// Shared with waitfor.ts so wait_for_user can warn about outstanding tasks.
export const bgTasks = new Map<string, BgTask>();

// senpi wake-source pattern: broadcast how many background tasks are in flight
// so the goal continuation can hold the agent awake (monitor mode) while they
// run. Event name mirrors senpi's shared WAKE_SOURCE_STATE_EVENT.
const WAKE_SOURCE_EVENT = "wake_source_state";
const WAKE_SOURCE_NAME = "sensei-task";

function emitWakeSource(pi: any): void {
  const active = [...bgTasks.values()].filter((t) => t.status === "running" || t.status === "orphaned");
  pi.events?.emit(WAKE_SOURCE_EVENT, {
    source: WAKE_SOURCE_NAME,
    activeCount: active.length,
    items: active.map((t) => ({ id: t.id, description: t.task.slice(0, 80), startedAtMs: t.startedAt })),
  });
}

export default function (pi: any) {
  const tasks = bgTasks;

  // Load persisted tasks and seed the id counter.
  let nextId = 1;
  try {
    for (const f of readdirSync(TASKS_DIR)) {
      const m = /^t(\d+)\.json$/.exec(f);
      if (!m) continue;
      nextId = Math.max(nextId, Number(m[1]) + 1);
      try {
        const rec = JSON.parse(readFileSync(join(TASKS_DIR, f), "utf8")) as BgTask;
        rec.child = undefined;
        tasks.set(rec.id, rec);
      } catch {}
    }
  } catch {}

  function completionMessage(t: BgTask): string {
    const notes = t.notes.length ? `\nNotes attached: ${t.notes.map((n) => `"${n}"`).join("; ")}` : "";
    return (
      `Background delegate ${t.id}${t.role ? ` (${t.role})` : ""} finished (${t.status}).\n` +
      `Task: ${t.task.slice(0, 300)}\n\n` +
      (t.result ? formatResult(t.result, t.timeoutS) : "(no result captured)") +
      notes
    );
  }

  function reportIfUnreported(t: BgTask): void {
    if (t.reported || t.status === "running" || t.status === "orphaned") return;
    t.reported = true;
    persist(t);
    pi.sendMessage(
      { customType: "sensei-task-result", content: completionMessage(t), display: true },
      { triggerTurn: true, deliverAs: "nextTurn" },
    );
  }

  // Finalize a task whose subprocess is gone, using its persisted output file.
  function finalizeFromOutput(t: BgTask): void {
    let jsonl = "";
    try {
      jsonl = readFileSync(taskOutPath(t.id), "utf8");
    } catch {}
    if (jsonl && outputIsTerminal(jsonl)) {
      const text = extractFinalText(jsonl);
      const truncated = text.length > MAX_OUTPUT_CHARS;
      t.result = { text: truncated ? text.slice(0, MAX_OUTPUT_CHARS) : text || "(no assistant output in recorded stream)", truncated, exitCode: null, timedOut: false };
      t.status = t.result.text ? "done" : "failed";
    } else {
      t.result = { text: "subprocess died without a recorded result", truncated: false, exitCode: null, timedOut: false };
      t.status = "failed";
    }
    t.endedAt = Date.now();
    t.pid = undefined;
    persist(t);
  }

  function launchTask(t: BgTask): void {
    const piBin = process.env.SENSEI_PI_BIN;
    if (!piBin) throw new Error("delegate: SENSEI_PI_BIN is not set (launch via the sensei wrapper)");
    try {
      mkdirSync(TASKS_DIR, { recursive: true });
    } catch {}
    const args = buildArgs(piBin, t);
    const { child, done } = spawnDelegate(piBin, args, t.cwd, taskOutPath(t.id));
    t.child = child;
    t.pid = child.pid;
    t.status = "running";
    persist(t);
    const timer = setTimeout(() => {
      if (t.status === "running") {
        t.result = { ...(t.result ?? { text: "", truncated: false, exitCode: null }), timedOut: true };
        child.kill("SIGTERM");
      }
    }, t.timeoutS * 1000);
    done.then((res) => {
      clearTimeout(timer);
      t.endedAt = Date.now();
      t.pid = undefined;
      t.result = res.timedOut ? res : { ...res, timedOut: t.result?.timedOut ?? false };
      if (t.status !== "cancelled") t.status = res.exitCode === 0 || res.text ? "done" : "failed";
      persist(t);
      emitWakeSource(pi);
      reportIfUnreported(t);
    });
    emitWakeSource(pi);
  }

  function registerBg(piBin: string, params: any, cwd: string, timeoutS: number): BgTask {
    const entry: BgTask = {
      id: `t${nextId++}`,
      task: params.task,
      role: params.role,
      model: params.model,
      cwd,
      timeoutS,
      status: "running",
      startedAt: Date.now(),
      reported: false,
      notes: [],
    };
    tasks.set(entry.id, entry);
    launchTask(entry);
    return entry;
  }

  // Reap orphans left by a previous session once the agent is up.
  pi.on("session_start", () => {
    for (const t of tasks.values()) {
      if (t.status !== "running") {
        reportIfUnreported(t); // finished but never delivered (e.g. parent died mid-flight)
        continue;
      }
      if (pidAlive(t.pid)) {
        t.status = "orphaned"; // still running but detached from any live parent
      } else {
        finalizeFromOutput(t);
        reportIfUnreported(t);
      }
    }
    emitWakeSource(pi);
  });

  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description:
      "Delegate a self-contained task to a subagent: a fresh pi process with its own history. " +
      "Pass `role` to use a specialist (explorer|librarian|oracle|designer|fixer|observer) with a tuned system prompt and tool limits. " +
      "Pass `background=true` to run it async and get a task id back; results arrive automatically when done. " +
      "The task prompt must be fully self-contained — the subagent sees only what you write in it.",
    promptSnippet: "delegate — run a self-contained subtask in a fresh headless pi subprocess (optional specialist role, optional background)",
    promptGuidelines: [
      "Delegate independent, well-specified subtasks; keep coordination in the parent session.",
      "Write self-contained task prompts: relevant paths, constraints, and the exact deliverable expected back.",
      "Prefer the specialist roles: explorer (codebase search), librarian (docs research), oracle (architecture/review advice), designer (UI/UX), fixer (implementation), observer (visual analysis).",
      "Use background=true for independent work that can run in parallel; collect results with task_list/task_status.",
    ],
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "Self-contained task prompt for the subagent" },
        role: {
          type: "string",
          enum: Object.keys(ROLES),
          description: "Specialist role: explorer|librarian|oracle|designer|fixer|observer",
        },
        background: { type: "boolean", description: "Run asynchronously; returns a task id (default false)" },
        cwd: { type: "string", description: "Working directory for the subagent (default: current directory)" },
        model: { type: "string", description: "Optional model override, e.g. 'openai/gpt-5' or a fuzzy pattern" },
        timeoutSeconds: { type: "number", description: `Kill the subagent after this many seconds (default ${DEFAULT_TIMEOUT_S})` },
      },
      required: ["task"],
      additionalProperties: false,
    },
    executionMode: "parallel",
    async execute(_id: string, params: any, signal: any, onUpdate: any, ctx: any) {
      const depth = Number(process.env.SENSEI_DELEGATE_DEPTH ?? "0");
      if (depth >= MAX_DEPTH) {
        throw new Error(`delegate: depth limit ${MAX_DEPTH} reached — refusing nested delegation`);
      }
      const piBin = process.env.SENSEI_PI_BIN;
      if (!piBin) {
        throw new Error("delegate: SENSEI_PI_BIN is not set (launch via the sensei wrapper)");
      }
      if (params.role && !ROLES[params.role]) {
        throw new Error(`delegate: unknown role "${params.role}" — valid: ${Object.keys(ROLES).join(", ")}`);
      }
      const cwd = params.cwd ?? ctx.cwd ?? process.cwd();
      const timeoutS = params.timeoutSeconds ?? DEFAULT_TIMEOUT_S;

      if (params.background) {
        if (tasks.size >= MAX_TASKS) throw new Error(`delegate: task table full (${MAX_TASKS})`);
        const entry = registerBg(piBin, params, cwd, timeoutS);
        return {
          content: [{ type: "text", text: `Background task ${entry.id} started${entry.role ? ` (role: ${entry.role})` : ""}. Use task_status ${entry.id} to check progress; the result will arrive automatically when it finishes.` }],
          details: { taskId: entry.id, role: entry.role },
        };
      }

      const args = buildArgs(piBin, params);
      onUpdate?.({ content: [{ type: "text", text: `delegating${params.role ? ` (${params.role})` : ""} (depth ${depth + 1}/${MAX_DEPTH})…` }] });
      const { child, done } = spawnDelegate(piBin, args, cwd);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutS * 1000);
      const abort = () => child.kill("SIGTERM");
      signal?.addEventListener("abort", abort, { once: true });
      const res = await done;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      res.timedOut = res.timedOut || timedOut;
      return {
        content: [{ type: "text", text: formatResult(res, timeoutS) }],
        details: { exitCode: res.exitCode, timedOut: res.timedOut, depth: depth + 1, role: params.role },
      };
    },
  });

  pi.registerTool({
    name: "task_list",
    label: "Task List",
    description: "List background delegate tasks with status, role, and elapsed time. Includes tasks from earlier sessions.",
    promptSnippet: "task_list — list background delegate tasks",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      if (tasks.size === 0) return { content: [{ type: "text", text: "No background tasks." }], details: {} };
      const lines = [...tasks.values()].map((t) => {
        const secs = Math.round(((t.endedAt ?? Date.now()) - t.startedAt) / 1000);
        return `${t.id} [${t.status}]${t.role ? ` role=${t.role}` : ""} ${secs}s — ${t.task.slice(0, 80)}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }], details: { count: tasks.size } };
    },
  });

  pi.registerTool({
    name: "task_status",
    label: "Task Status",
    description: "Show a background delegate task's status and (once finished) its result.",
    promptSnippet: "task_status — check a background delegate task",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Task id from delegate(background=true)" } },
      required: ["id"],
      additionalProperties: false,
    },
    async execute(_id: string, params: any) {
      const t = tasks.get(params.id);
      if (!t) return { content: [{ type: "text", text: `Unknown task ${params.id}` }], details: {} };
      const secs = Math.round(((t.endedAt ?? Date.now()) - t.startedAt) / 1000);
      let text = `${t.id} [${t.status}] ${secs}s\nTask: ${t.task}`;
      if (t.notes.length) text += `\nNotes: ${t.notes.map((n) => `"${n}"`).join("; ")}`;
      if (t.status !== "running" && t.status !== "orphaned" && t.result) text += `\n\nResult:\n${t.result.text}`;
      return { content: [{ type: "text", text }], details: { status: t.status } };
    },
  });

  pi.registerTool({
    name: "task_cancel",
    label: "Task Cancel",
    description: "Kill a running or orphaned background delegate task.",
    promptSnippet: "task_cancel — kill a running background delegate task",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Task id to cancel" } },
      required: ["id"],
      additionalProperties: false,
    },
    async execute(_id: string, params: any) {
      const t = tasks.get(params.id);
      if (!t) return { content: [{ type: "text", text: `Unknown task ${params.id}` }], details: {} };
      if (t.status !== "running" && t.status !== "orphaned") {
        return { content: [{ type: "text", text: `Task ${t.id} already ${t.status}.` }], details: { status: t.status } };
      }
      if (t.status === "orphaned" && t.pid && pidAlive(t.pid)) {
        try {
          process.kill(t.pid, "SIGTERM");
        } catch {}
      } else {
        t.child?.kill("SIGTERM");
      }
      t.status = "cancelled";
      t.endedAt = Date.now();
      persist(t);
      emitWakeSource(pi);
      return { content: [{ type: "text", text: `Task ${t.id} cancelled.` }], details: { status: "cancelled" } };
    },
  });

  pi.registerTool({
    name: "task_revive",
    label: "Task Revive",
    description:
      "Respawn a finished, failed, cancelled, or orphaned background task with its original task prompt, role, model, cwd, and timeout.",
    promptSnippet: "task_revive — respawn a dead background task with its saved parameters",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Task id to revive" } },
      required: ["id"],
      additionalProperties: false,
    },
    async execute(_id: string, params: any) {
      const t = tasks.get(params.id);
      if (!t) return { content: [{ type: "text", text: `Unknown task ${params.id}` }], details: {} };
      if (t.status === "running") return { content: [{ type: "text", text: `Task ${t.id} is still running.` }], details: { status: t.status } };
      if (t.status === "orphaned" && pidAlive(t.pid)) {
        return { content: [{ type: "text", text: `Task ${t.id} is orphaned but its subprocess (pid ${t.pid}) is still alive — task_cancel it first if you want to respawn.` }], details: { status: t.status } };
      }
      t.startedAt = Date.now();
      t.endedAt = undefined;
      t.result = undefined;
      t.reported = false;
      t.child = undefined;
      try {
        unlinkSync(taskOutPath(t.id));
      } catch {}
      launchTask(t);
      return { content: [{ type: "text", text: `Task ${t.id} revived — running again with its original parameters.` }], details: { status: "running" } };
    },
  });

  pi.registerTool({
    name: "task_send",
    label: "Task Send",
    description:
      "Attach a note to a background task. The note is stored and delivered to the parent session with the task's completion result — " +
      "it does NOT reach the running subprocess (pi subagents have no live input channel).",
    promptSnippet: "task_send — attach a note delivered with the task's completion",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task id" },
        message: { type: "string", description: "Note to attach" },
      },
      required: ["id", "message"],
      additionalProperties: false,
    },
    async execute(_id: string, params: any) {
      const t = tasks.get(params.id);
      if (!t) return { content: [{ type: "text", text: `Unknown task ${params.id}` }], details: {} };
      const message = String(params.message ?? "").trim();
      if (!message) return { content: [{ type: "text", text: "task_send requires a non-empty message." }], details: {} };
      t.notes.push(message);
      persist(t);
      return {
        content: [{ type: "text", text: `Note queued on ${t.id}. It will be delivered with the task's completion result — the running subprocess itself cannot see it. To actually change its instructions, task_revive or delegate a follow-up task.` }],
        details: { taskId: t.id },
      };
    },
  });
}
