#!/usr/bin/env node
// sensei launcher: runs the pinned pi-coding-agent host with sensei's own
// agent dir (settings/extensions/skills), so it never touches ~/.pi or ~/.senpi.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Versions for the startup banner. Read here, in the wrapper, because extensions
// stay import-free (see README) and cannot reach either package.json themselves.
// Cosmetic only: a missing or malformed manifest must never block a launch.
function readVersion(manifest) {
  try {
    return JSON.parse(readFileSync(manifest, "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const agentDir = resolve(process.env.SENSEI_AGENT_DIR ?? join(homedir(), ".sensei"));
const template = join(root, "agent-template");

// Seed on first run; always re-sync OWNED surfaces (extensions/, skills/) so a
// sensei upgrade propagates, but never clobber user config (settings/models/
// prompts/auth/presets/rules data files the user may have customized).
const OWNED_DIRS = ["extensions", "skills"];
const USER_FILES = ["settings.json", "models.json", "SYSTEM.md", "APPEND_SYSTEM.md"];
if (!existsSync(agentDir)) {
  mkdirSync(dirname(agentDir), { recursive: true });
  cpSync(template, agentDir, { recursive: true });
  console.log(`sensei: seeded agent dir at ${agentDir}`);
} else {
  for (const dir of OWNED_DIRS) {
    cpSync(join(template, dir), join(agentDir, dir), { recursive: true, force: true });
  }
  for (const file of USER_FILES) {
    const src = join(template, file);
    const dst = join(agentDir, file);
    if (existsSync(src) && !existsSync(dst)) cpSync(src, dst);
  }
}

const hostPkg = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
const pi = join(hostPkg, "dist", "bundle", "cli.js");
if (!existsSync(pi)) {
  console.error("sensei: pi host not installed. Run `npm install --ignore-scripts` in the sensei repo.");
  process.exit(1);
}

// Point extensions at the vendored ast-grep binary when it's installed.
const sgBin = join(root, "node_modules", "@ast-grep", "cli", process.platform === "win32" ? "sg.exe" : "sg");
const sgEnv = !process.env.SENSEI_SG_PATH && existsSync(sgBin) ? { SENSEI_SG_PATH: sgBin } : {};

const res = spawnSync(process.execPath, [pi, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    SENSEI_AGENT_DIR: agentDir,
    SENSEI_REPO_ROOT: root,
    SENSEI_PI_BIN: pi,
    SENSEI_VERSION: readVersion(join(root, "package.json")),
    SENSEI_HOST_VERSION: readVersion(join(hostPkg, "package.json")),
    ...sgEnv,
  },
});
process.exit(res.status ?? 1);
