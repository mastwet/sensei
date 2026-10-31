import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function profile(t) {
  const dir = mkdtempSync(join(tmpdir(), "sensei-host-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agent = join(dir, "agent");
  const cwd = join(dir, "project");
  mkdirSync(cwd);
  cpSync(join(root, "agent-template"), agent, { recursive: true });
  const trace = join(dir, "calls.jsonl");
  writeFileSync(trace, "");
  return {
    agent, cwd, trace,
    env(scenario) {
      return { ...process.env, SENSEI_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0",
        SENSEI_TEST_SCENARIO: scenario, SENSEI_TEST_TRACE: trace };
    },
    run(args, scenario = "basic") {
      const result = spawnSync(process.execPath, [join(root, "bin/sensei.mjs"), ...args], {
        cwd, encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024,
        env: this.env(scenario),
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.doesNotMatch(result.stderr, /extension.*(error|failed)|TypeError|not a function/i);
      return result.stdout;
    },
  };
}

const sessionArgs = ["--offline", "--approve", "--no-session", "--mode", "json", "-p",
  "-e", join(root, "tests/fixtures/provider.ts"), "--provider", "sensei-test", "--model", "fixture"];
const events = (out) => out.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
const replies = (out) => events(out).filter((e) => e.type === "message_end" && e.message?.role === "assistant")
  .flatMap((e) => e.message.content.filter((c) => c.type === "text").map((c) => c.text));

async function rpc(p, commands, scenario, extraArgs = [], onSettled) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [join(root, "bin/sensei.mjs"),
      ...sessionArgs.filter((arg) => arg !== "-p").map((arg) => arg === "json" ? "rpc" : arg), ...extraArgs], {
      cwd: p.cwd, env: p.env(scenario), stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", buffer = "", next = 0;
    const timeout = setTimeout(() => { child.kill(); reject(new Error("RPC session timed out")); }, 15000);
    const sendNext = () => {
      if (next < commands.length) child.stdin.write(JSON.stringify({ id: `cmd-${next}`, type: "prompt", message: commands[next++] }) + "\n");
    };
    child.stdout.on("data", (data) => {
      stdout += data;
      buffer += data;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("{")) continue;
        const e = JSON.parse(line);
        if (e.type === "extension_error") { stderr += line; child.stdin.end(); }
        if (e.type === "response") {
          if (!e.success) { child.stdin.end(); stderr += line; }
          else sendNext();
        }
        if (e.type === "agent_settled" && !onSettled?.(e, child)) child.stdin.end();
      }
    });
    child.stderr.on("data", (data) => { stderr += data; if (/Extension error/.test(stderr)) child.stdin.end(); });
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      try {
        assert.equal(code, 0, stderr);
        assert.doesNotMatch(stderr, /error|failed|not a function/i);
        done(stdout);
      } catch (error) { reject(error); }
    });
    sendNext();
  });
}

test("launcher runs the locked host and preserves existing user configuration", (t) => {
  const p = profile(t);
  const settings = '{"quietStartup":true,"defaultTools":["read"]}\n';
  const models = '{"providers":{}}\n';
  writeFileSync(join(p.agent, "settings.json"), settings);
  writeFileSync(join(p.agent, "models.json"), models);
  const pinned = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies["@earendil-works/pi-coding-agent"];
  assert.equal(p.run(["--version"]).trim(), pinned);
  assert.equal(readFileSync(join(p.agent, "settings.json"), "utf8"), settings);
  assert.equal(readFileSync(join(p.agent, "models.json"), "utf8"), models);
  assert.match(p.run(["--help"]), /--no-nested-agents/);
});

test("owned tools execute through native codemode with timeout and nested AGENTS hooks", (t) => {
  const p = profile(t);
  mkdirSync(join(p.cwd, "nested"));
  writeFileSync(join(p.cwd, "nested/sample.txt"), "sample-body");
  writeFileSync(join(p.cwd, "nested/AGENTS.md"), "NESTED_INSTRUCTION_SENTINEL");
  const out = p.run([...sessionArgs, "Exercise owned tools"], "tools");
  const calls = readFileSync(p.trace, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.ok(calls.some((c) => c.toolName === "todo"), out);
  assert.equal(calls.find((c) => c.toolName === "bash")?.input.timeout, 1800);
  const result = replies(out).at(-1);
  assert.match(result, /migration verified/);
  assert.match(result, /sample-body/);
  assert.match(result, /NESTED_INSTRUCTION_SENTINEL/);
  assert.ok(events(out).filter((e) => e.type === "tool_execution_end").every((e) => !e.isError), out);
});

test("/work submits its goal and continues at settle until the done marker", async (t) => {
  const p = profile(t);
  const out = await rpc(p, ["/work verify host migration"], "work");
  assert.deepEqual(replies(out), ["Still working.", "Finished.\n<sensei:done/>"]);
});

test("/goal resume submits a paused goal and records completion", async (t) => {
  const p = profile(t);
  const out = await rpc(p, ["/goal set verify host migration", "/goal pause", "/goal resume"], "goal");
  assert.deepEqual(replies(out), ["host-ok"]);
  assert.match(readFileSync(p.trace, "utf8"), /complete/);
});

test("an active goal continues after a final assistant message until completed", (t) => {
  const p = profile(t);
  const out = p.run([...sessionArgs, "Exercise goal continuation"], "goal-continuation");
  assert.deepEqual(replies(out), ["Still working.", "host-ok"]);
});

test("a due headless loop adds a continuation after a final assistant message", (t) => {
  const p = profile(t);
  const out = p.run([...sessionArgs, "Exercise scheduled continuation"], "loop");
  assert.deepEqual(replies(out), ["Before loop.", "After loop."]);
});

test("a restored due loop submits its prompt at session startup", async (t) => {
  const p = profile(t);
  const id = "11111111-1111-4111-8111-111111111111";
  mkdirSync(join(p.agent, "loops"));
  const loopFile = join(p.agent, "loops", `${id}.json`);
  writeFileSync(loopFile, JSON.stringify({ version: 1, jobs: [{
    id: "restored", task: "RESTORED_LOOP_SENTINEL", everyMinutes: 1,
    nextRunAt: 1, timesLeft: 1, createdAt: 1,
  }] }));
  const out = await rpc(p, [], "background", ["--session-id", id]);
  assert.match(replies(out).at(-1), /RESTORED_LOOP_SENTINEL/);
  assert.deepEqual(JSON.parse(readFileSync(loopFile, "utf8")).jobs, []);
});

test("/work respects an aborted run without sending a continuation", async (t) => {
  const p = profile(t);
  const out = await rpc(p, ["/work verify cancellation"], "aborted");
  assert.equal(replies(out).length, 1);
  assert.ok(events(out).some((e) => e.type === "message_end" && e.message?.stopReason === "aborted"));
});

test("a host abort disarms /work before the next unrelated user prompt", async (t) => {
  const p = profile(t);
  const out = await rpc(p, ["/work old goal"], "user-abort", [], (event, child) => {
    if (!event.aborted) return false;
    child.stdin.write(JSON.stringify({ id: "new-prompt", type: "prompt", message: "An unrelated new question" }) + "\n");
    return true;
  });
  assert.ok(events(out).some((e) => e.type === "agent_settled" && e.aborted));
  assert.deepEqual(replies(out), ["Still working."]);
});

test("/work stops when its continuation budget is exhausted", async (t) => {
  const p = profile(t);
  const out = await rpc(p, ["/work exercise continuation cap"], "basic");
  assert.equal(replies(out).length, 41);
});

test("an unfinished goal pauses when its continuation budget is exhausted", (t) => {
  const p = profile(t);
  const out = p.run([...sessionArgs, "Exercise goal cap"], "goal-cap");
  assert.equal(replies(out).length, 9);
  const goals = join(p.agent, "goals");
  const { goal } = JSON.parse(readFileSync(join(goals, readdirSync(goals)[0]), "utf8"));
  assert.equal(goal.status, "paused");
  assert.equal(goal.continuations, 8);
});

test("custom-message runs keep rules, preset and timeout system prompt sections", (t) => {
  const p = profile(t);
  mkdirSync(join(p.agent, "rules"));
  mkdirSync(join(p.agent, "presets"));
  writeFileSync(join(p.agent, "rules/test.md"), "RULE_SENTINEL");
  // Select the user-owned preset through its normal command.
  writeFileSync(join(p.agent, "presets/test.md"), "PRESET_SENTINEL");
  const out = p.run([...sessionArgs, "/preset test", "/test-custom"], "context");
  const result = replies(out).at(-1);
  assert.match(result, /RULE_SENTINEL/);
  assert.match(result, /PRESET_SENTINEL/);
  assert.match(result, /Bash Tool Timeout Policy/);
});

test("a saved background completion is delivered once and marked reported", (t) => {
  const p = profile(t);
  mkdirSync(join(p.agent, "tasks"));
  const taskFile = join(p.agent, "tasks/t1.json");
  writeFileSync(taskFile, JSON.stringify({
    id: "t1", task: "Saved task", cwd: p.cwd, timeoutS: 30, status: "done", startedAt: 1,
    reported: false, notes: [], result: { text: "BACKGROUND_SENTINEL", truncated: false, exitCode: 0, timedOut: false },
  }));
  const out = p.run([...sessionArgs, "Hello"], "background");
  assert.equal((replies(out).at(-1).match(/BACKGROUND_SENTINEL/g) ?? []).length, 1);
  assert.equal(JSON.parse(readFileSync(taskFile, "utf8")).reported, true);
  const again = p.run([...sessionArgs, "Hello again"], "background");
  assert.ok(!again.includes("BACKGROUND_SENTINEL"), again);
});
