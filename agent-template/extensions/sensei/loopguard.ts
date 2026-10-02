// loopguard — faithful port of senpi builtin `loop-guard/` (single-file, dependency-free).
// Identical-loop reminders + first-veto blocking + hard-stop abort&recover.
// Similar/cyclic loops stay advisory, matching senpi policy.ts thresholds.
// Differs only where the senpi host surface doesn't exist on pi 0.87.1:
// ctx.abort() takes no reason arg; monitor-state event emissions kept (pi.events exists).

// ---- policy.ts (verbatim thresholds) ----
const TRACK_WINDOW = 64;
const IDENTICAL_RUN_THRESHOLD = 3;
const IDENTICAL_BLOCK_NOTICE_THRESHOLD = 2;
const IDENTICAL_HARD_STOP_BLOCK_THRESHOLD = 3;
const SIMILAR_RUN_THRESHOLD = 5;
const SIMILARITY_THRESHOLD = 0.85;
const CYCLE_MIN_PERIOD = 2;
const CYCLE_MAX_PERIOD = 6;
const CYCLE_REPETITION_THRESHOLD = 3;
const ESCALATION_FACTOR = 2;

// ---- tracker.ts ----
interface ToolCallRecord {
  toolName: string;
  argsJson: string;
  signature: string;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const entry = record[key];
    if (entry === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${stableStringify(entry)}`);
  }
  return `{${parts.join(",")}}`;
}

function canonicalizeArgs(args: unknown): string {
  return stableStringify(args ?? {});
}

class ToolCallTracker {
  private calls: ToolCallRecord[] = [];
  record(toolName: string, args: unknown): ToolCallRecord {
    const argsJson = canonicalizeArgs(args);
    const record = { toolName, argsJson, signature: `${toolName}${argsJson}` };
    this.calls.push(record);
    if (this.calls.length > TRACK_WINDOW) this.calls = this.calls.slice(-TRACK_WINDOW);
    return record;
  }
  get records(): readonly ToolCallRecord[] {
    return this.calls;
  }
  reset(): void {
    this.calls = [];
  }
}

// ---- similarity.ts ----
type BigramCounts = Map<string, number>;

function bigramCounts(text: string): BigramCounts {
  const counts: BigramCounts = new Map();
  for (let i = 0; i < text.length - 1; i++) {
    const gram = text.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

function diceSimilarity(a: BigramCounts, b: BigramCounts): number {
  let totalA = 0;
  for (const c of a.values()) totalA += c;
  let totalB = 0;
  for (const c of b.values()) totalB += c;
  if (totalA === 0 && totalB === 0) return 1;
  if (totalA === 0 || totalB === 0) return 0;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const [gram, count] of small) {
    const other = large.get(gram);
    if (other !== undefined) intersection += Math.min(count, other);
  }
  return (2 * intersection) / (totalA + totalB);
}

function meanAdjacentSimilarity(argStrings: readonly string[]): number {
  if (argStrings.length < 2) return 1;
  const grams = argStrings.map(bigramCounts);
  let total = 0;
  for (let i = 0; i < grams.length - 1; i++) {
    const current = grams[i];
    const next = grams[i + 1];
    if (!current || !next) continue;
    total += diceSimilarity(current, next);
  }
  return total / (grams.length - 1);
}

// ---- detectors.ts ----
const TARGET_FIELDS = new Map<string, readonly string[]>([
  ["read", ["path"]],
  ["bash_output", ["bash_id"]],
  ["task_output", ["task_id", "name"]],
  ["task_status", ["id", "task_id"]],
  ["task_update", ["task_id"]],
  ["task_send", ["id"]],
  ["task_cancel", ["id"]],
  ["task_revive", ["id"]],
  ["lsp_diagnostics", ["filePath"]],
]);

type LoopGuardDetection =
  | { kind: "identical"; toolName: string; count: number; fingerprint: string }
  | { kind: "similar"; toolName: string; count: number; similarity: number; fingerprint: string }
  | { kind: "cycle"; period: number; count: number; cycleTools: readonly string[]; fingerprint: string };

type LoopGuardKind = LoopGuardDetection["kind"];

function targetIdentity(record: ToolCallRecord): string | undefined {
  const fields = TARGET_FIELDS.get(record.toolName);
  if (fields === undefined) return undefined;
  let args: unknown;
  try {
    args = JSON.parse(record.argsJson);
  } catch {
    return undefined;
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  for (const field of fields) {
    const value: unknown = (args as Record<string, unknown>)[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function hasAllDistinctTargets(records: readonly ToolCallRecord[]): boolean {
  const identities: string[] = [];
  for (const record of records) {
    const identity = targetIdentity(record);
    if (identity === undefined) return false;
    identities.push(identity);
  }
  return new Set(identities).size === identities.length;
}

function detectIdenticalRun(records: readonly ToolCallRecord[]): LoopGuardDetection | undefined {
  const last = records[records.length - 1];
  if (last === undefined) return undefined;
  let run = 1;
  for (let i = records.length - 2; i >= 0; i--) {
    if (records[i]?.signature !== last.signature) break;
    run++;
  }
  if (run < IDENTICAL_RUN_THRESHOLD) return undefined;
  return { kind: "identical", toolName: last.toolName, count: run, fingerprint: last.signature };
}

function detectSimilarRun(records: readonly ToolCallRecord[]): LoopGuardDetection | undefined {
  const last = records[records.length - 1];
  if (last === undefined) return undefined;
  let run = 1;
  for (let i = records.length - 2; i >= 0; i--) {
    if (records[i]?.toolName !== last.toolName) break;
    run++;
  }
  if (run < SIMILAR_RUN_THRESHOLD) return undefined;
  const runRecords = records.slice(records.length - run);
  const argStrings = runRecords.map((r) => r.argsJson);
  if (new Set(argStrings).size === 1) return undefined;
  if (hasAllDistinctTargets(runRecords)) return undefined;
  const similarity = meanAdjacentSimilarity(argStrings);
  if (similarity < SIMILARITY_THRESHOLD) return undefined;
  return { kind: "similar", toolName: last.toolName, count: run, similarity, fingerprint: last.toolName };
}

function detectCycle(records: readonly ToolCallRecord[]): LoopGuardDetection | undefined {
  const total = records.length;
  for (let period = CYCLE_MIN_PERIOD; period <= CYCLE_MAX_PERIOD; period++) {
    if (total < period * CYCLE_REPETITION_THRESHOLD) continue;
    const cycle = records.slice(total - period);
    if (new Set(cycle.map((r) => r.signature)).size < 2) continue;
    let repetitions = 1;
    while (repetitions * period + period <= total) {
      const blockStart = total - (repetitions + 1) * period;
      let matches = true;
      for (let offset = 0; offset < period; offset++) {
        if (records[blockStart + offset]?.signature !== cycle[offset]?.signature) {
          matches = false;
          break;
        }
      }
      if (!matches) break;
      repetitions++;
    }
    if (repetitions < CYCLE_REPETITION_THRESHOLD) continue;
    return {
      kind: "cycle",
      period,
      count: repetitions,
      cycleTools: cycle.map((r) => r.toolName),
      fingerprint: cycle.map((r) => r.signature).join(""),
    };
  }
  return undefined;
}

interface GateEntry {
  fingerprint: string;
  lastNotifiedCount: number;
  saturationNotified: boolean;
}

function maximumObservableCount(detection: LoopGuardDetection): number {
  switch (detection.kind) {
    case "identical":
    case "similar":
      return TRACK_WINDOW;
    case "cycle":
      return Math.floor(TRACK_WINDOW / detection.period);
  }
}

class NoticeGate {
  private entries = new Map<LoopGuardKind, GateEntry>();
  admit(detection: LoopGuardDetection): boolean {
    const maximumCount = maximumObservableCount(detection);
    const existing = this.entries.get(detection.kind);
    if (existing === undefined || existing.fingerprint !== detection.fingerprint) {
      this.entries.set(detection.kind, {
        fingerprint: detection.fingerprint,
        lastNotifiedCount: detection.count,
        saturationNotified: detection.count >= maximumCount,
      });
      return true;
    }
    const reachedDoubledCount = detection.count >= existing.lastNotifiedCount * ESCALATION_FACTOR;
    const reachedSaturation = !existing.saturationNotified && detection.count >= maximumCount;
    if (reachedDoubledCount || reachedSaturation) {
      existing.lastNotifiedCount = detection.count;
      if (reachedSaturation) existing.saturationNotified = true;
      return true;
    }
    return false;
  }
  prune(active: ReadonlyMap<LoopGuardKind, string>): void {
    for (const [kind, entry] of this.entries) {
      if (active.get(kind) !== entry.fingerprint) this.entries.delete(kind);
    }
  }
  reset(): void {
    this.entries.clear();
  }
}

function detectLoop(records: readonly ToolCallRecord[], gate: NoticeGate): LoopGuardDetection | undefined {
  const detections = [detectIdenticalRun(records), detectCycle(records), detectSimilarRun(records)];
  const active = new Map<LoopGuardKind, string>();
  for (const d of detections) if (d !== undefined) active.set(d.kind, d.fingerprint);
  gate.prune(active);
  for (const d of detections) if (d !== undefined && gate.admit(d)) return d;
  return undefined;
}

// ---- escalation.ts ----
type IdenticalEscalationDecision =
  | { kind: "allow" }
  | { kind: "block"; toolName: string; blockedCallCount: number }
  | { kind: "hardStop"; toolName: string; blockedCallCount: number; announce: boolean };

interface IdenticalLoopEpisode {
  fingerprint: string;
  toolName: string;
  admittedNoticeCount: number;
  activateBlockAfterAttempt: boolean;
  blockActive: boolean;
  blockedCallCount: number;
  hardStopAnnounced: boolean;
}

const ALLOW_DECISION = { kind: "allow" } as const;

class IdenticalLoopEscalation {
  private episode: IdenticalLoopEpisode | undefined;
  private readonly attempts = new Map<string, ToolCallRecord>();

  observeAttempt(toolCallId: string, record: ToolCallRecord): boolean {
    const patternChanged = this.episode !== undefined && this.episode.fingerprint !== record.signature;
    if (patternChanged) this.reset();
    this.attempts.set(toolCallId, record);
    return patternChanged;
  }

  observeNotice(detection: LoopGuardDetection): void {
    switch (detection.kind) {
      case "similar":
      case "cycle":
        return;
      case "identical": {
        if (this.episode === undefined || this.episode.fingerprint !== detection.fingerprint) {
          this.episode = {
            fingerprint: detection.fingerprint,
            toolName: detection.toolName,
            admittedNoticeCount: 0,
            activateBlockAfterAttempt: false,
            blockActive: false,
            blockedCallCount: 0,
            hardStopAnnounced: false,
          };
        }
        this.episode.admittedNoticeCount++;
        if (this.episode.admittedNoticeCount >= IDENTICAL_BLOCK_NOTICE_THRESHOLD) {
          this.episode.activateBlockAfterAttempt = true;
        }
      }
    }
  }

  finishTurn(): void {
    this.attempts.clear();
  }

  consumeToolCall(toolCallId: string): IdenticalEscalationDecision {
    const attempt = this.attempts.get(toolCallId);
    this.attempts.delete(toolCallId);
    if (attempt === undefined || this.episode === undefined || this.episode.fingerprint !== attempt.signature) {
      return ALLOW_DECISION;
    }
    if (!this.episode.blockActive) {
      if (this.episode.activateBlockAfterAttempt) {
        this.episode.activateBlockAfterAttempt = false;
        this.episode.blockActive = true;
      }
      return ALLOW_DECISION;
    }
    this.episode.blockedCallCount++;
    if (this.episode.blockedCallCount >= IDENTICAL_HARD_STOP_BLOCK_THRESHOLD) {
      const announce = !this.episode.hardStopAnnounced;
      this.episode.hardStopAnnounced = true;
      return { kind: "hardStop", toolName: this.episode.toolName, blockedCallCount: this.episode.blockedCallCount, announce };
    }
    return { kind: "block", toolName: this.episode.toolName, blockedCallCount: this.episode.blockedCallCount };
  }

  reset(): void {
    this.episode = undefined;
    this.attempts.clear();
  }
}

// ---- notice.ts (verbatim message text) ----
const POLLING_TOOL_NAMES = new Set(["bash_output", "task_output", "task_status"]);

function buildBlockReason(toolName: string, blockedCallCount: number): string {
  const recovery = POLLING_TOOL_NAMES.has(toolName)
    ? "Stop polling this target. If you need to wait for a change, arm a monitor or rely on a completion notification when this mode supports it; otherwise re-plan or choose a different tool."
    : "Reuse the existing result, stop repeating this call, and re-plan from the current goal or choose a different tool.";
  return `Loop guard blocked repeated call ${blockedCallCount} to \`${toolName}\` with arguments that already triggered two identical-call warnings. ${recovery}`;
}

function buildHardStopWarning(toolName: string, blockedCallCount: number): string {
  return `Loop guard interrupted the turn after blocking ${blockedCallCount} repeated calls to ${toolName}.`;
}

function buildHardStopSteer(toolName: string): string {
  return [
    `The loop guard stopped the previous turn because you kept calling \`${toolName}\` with arguments that had already been blocked.`,
    "Do not repeat that call. Re-plan from the current goal and use a different tool or deliberately changed arguments.",
  ].join(" ");
}

function buildReminder(detection: LoopGuardDetection): string {
  switch (detection.kind) {
    case "identical": {
      const { toolName, count } = detection;
      return [
        `<system-reminder>`,
        `LOOP GUARD - IDENTICAL TOOL CALLS: you called \`${toolName}\` ${count} times in a row with the EXACT same arguments. This is the tool-call stream, not consecutive text - another tool ran between these calls and it changed nothing about your plan. Re-issuing the same call returns the same result. Snap out of it:`,
        `- reuse the result you already received from this exact call;`,
        `- if you were re-checking for new output or state, switch to the monitor/watch tool or change one parameter deliberately (filter, offset, query);`,
        `- if nothing is actually changing, stop calling this tool, state what is blocking you, and try a different tool or ask the user.`,
        `Do not call \`${toolName}\` again with identical arguments.`,
        `</system-reminder>`,
      ].join("\n");
    }
    case "similar": {
      const { toolName, count, similarity } = detection;
      const percent = Math.round(similarity * 100);
      return [
        `<system-reminder>`,
        `LOOP GUARD - NEAR-IDENTICAL TOOL CALLS: your last ${count} calls to \`${toolName}\` had arguments about ${percent}% identical (bigram similarity over canonical args). This may be legitimate batch work - or it may be a lazy loop that only LOOKS like progress. Attention check:`,
        `- if these calls target genuinely different inputs (distinct files, queries, offsets), continue deliberately - but consider batching or widening the scope instead of one call per tiny variation;`,
        `- if you are scanning output incrementally (reads, peeks, polls), widen the window once or use the monitor/watch tool rather than nudging parameters;`,
        `- if the results keep saying the same thing, change strategy now - a different tool, a wider query, or asking the user beats a sixth near-copy.`,
        `</system-reminder>`,
      ].join("\n");
    }
    case "cycle": {
      const { period, count, cycleTools } = detection;
      const pattern = cycleTools.join(" -> ");
      return [
        `<system-reminder>`,
        `LOOP GUARD - REPEATING TOOL-CALL PATTERN: your recent tool calls repeat the cycle [${pattern}] ${count} times (period ${period}), with other calls possibly interleaved between repetitions. A fixed rotation usually means waiting, guessing, or searching without a discriminator:`,
        `- if this is a wait/poll rotation (spawn then peek, write then check), replace the rotation with the monitor/watch tool and react to the decisive event instead;`,
        `- if this is a search rotation, change ONE axis decisively: broader query, different tool, or a different source - repeating the same rotation at the same parameters will not find new information;`,
        `- if the cycle is genuinely progressing (each rotation moves distinct work forward), keep going - but say what each rotation accomplished so the next rotation can end.`,
        `</system-reminder>`,
      ].join("\n");
    }
  }
}

// ---- index.ts wiring ----
const NOTICE_TYPE = "sensei-loop-guard:notice";
const ESCALATION_TYPE = "sensei-loop-guard:escalation";
const RECOVERY_TYPE = "sensei-loop-guard:recovery";

export default function (pi: any): void {
  const tracker = new ToolCallTracker();
  const gate = new NoticeGate();
  const escalation = new IdenticalLoopEscalation();
  let pendingRecoveryToolName: string | undefined;

  const reset = (): void => {
    tracker.reset();
    gate.reset();
    escalation.reset();
    pendingRecoveryToolName = undefined;
  };

  try {
    pi.registerMessageRenderer?.(NOTICE_TYPE, (msg: any) => msg.content);
    pi.registerMessageRenderer?.(ESCALATION_TYPE, (msg: any) => msg.content);
    pi.registerMessageRenderer?.(RECOVERY_TYPE, (msg: any) => msg.content);
  } catch {
    // renderer optional — TUI falls back to generic display
  }

  pi.on("session_start", () => reset());
  pi.on("session_shutdown", () => reset());
  pi.on("session_before_switch", () => reset());
  pi.on("session_before_fork", () => reset());

  pi.on("input", (event: any) => {
    if (event.source !== "extension") reset();
  });

  pi.on("tool_execution_start", (event: any) => {
    const record = tracker.record(event.toolName, event.args);
    const patternChanged = escalation.observeAttempt(event.toolCallId, record);
    if (patternChanged) pendingRecoveryToolName = undefined;
    const detection = detectLoop(tracker.records, gate);
    if (detection === undefined) return;
    escalation.observeNotice(detection);
    pi.sendMessage(
      { customType: NOTICE_TYPE, content: buildReminder(detection), display: true, details: detection },
      { triggerTurn: false, deliverAs: "steer" },
    );
  });

  pi.on("turn_end", () => {
    escalation.finishTurn();
  });

  pi.on("tool_call", (event: any, ctx: any) => {
    const decision = escalation.consumeToolCall(event.toolCallId);
    switch (decision.kind) {
      case "allow":
        return undefined;
      case "block":
        return { block: true, reason: buildBlockReason(decision.toolName, decision.blockedCallCount), terminate: false };
      case "hardStop": {
        const warning = buildHardStopWarning(decision.toolName, decision.blockedCallCount);
        if (decision.announce) {
          pi.sendMessage(
            {
              customType: ESCALATION_TYPE,
              content: warning,
              display: true,
              details: { toolName: decision.toolName, blockedCallCount: decision.blockedCallCount },
            },
            { triggerTurn: false, deliverAs: "steer" },
          );
          if (ctx.hasUI) ctx.ui.notify(warning, "warning");
          pendingRecoveryToolName = decision.toolName;
        }
        ctx.abort();
        return { block: true, reason: buildBlockReason(decision.toolName, decision.blockedCallCount), terminate: false };
      }
    }
    return undefined;
  });

  pi.on("agent_settled", () => {
    const toolName = pendingRecoveryToolName;
    if (toolName === undefined) return;
    pendingRecoveryToolName = undefined;
    pi.sendMessage(
      { customType: RECOVERY_TYPE, content: buildHardStopSteer(toolName), display: false },
      { triggerTurn: true },
    );
  });
}
