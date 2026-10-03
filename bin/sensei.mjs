#!/usr/bin/env node
// sensei launcher: runs the pinned pi-coding-agent host with sensei's own
// agent dir (settings/extensions/skills), so it never touches ~/.pi or ~/.senpi.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

// Resolve an installed package's root directory by name, independent of where
// npm put it. A local checkout nests deps under sensei/node_modules, but a
// global `npm i -g` hoists them to an ancestor node_modules and sensei's own
// node_modules may not exist at all — so never join(root, "node_modules", ...).
function packageRoot(name) {
  let dir = null;
  try {
    // ESM resolution first: packages with an "exports" map (the pi host has one)
    // are invisible to require() and throw ERR_PACKAGE_PATH_NOT_EXPORTED.
    dir = dirname(fileURLToPath(import.meta.resolve(name)));
  } catch {
    // No ESM entry point — pure-binary wrapper packages like @ast-grep/cli.
    // Their manifest is still resolvable, so fall through to the try below.
  }
  if (dir) {
    for (;;) {
      if (basename(dir) === "node_modules") return null;
      if (existsSync(join(dir, "package.json"))) return dir;
      const up = dirname(dir);
      if (up === dir) return null;
      dir = up;
    }
  }
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    return null;
  }
}

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

// The @ast-grep/cli postinstall hard-links the platform binary into its own
// package. The dev bootstrap installs with --ignore-scripts (supply chain), so
// look in the platform-specific optional dependency too.
const AST_GREP_PLATFORM_PKG = {
  "darwin-arm64": "@ast-grep/cli-darwin-arm64",
  "darwin-x64": "@ast-grep/cli-darwin-x64",
  "win32-arm64": "@ast-grep/cli-win32-arm64-msvc",
  "win32-ia32": "@ast-grep/cli-win32-ia32-msvc",
  "win32-x64": "@ast-grep/cli-win32-x64-msvc",
  "linux-arm64": "@ast-grep/cli-linux-arm64-gnu",
  "linux-x64": "@ast-grep/cli-linux-x64-gnu",
}[`${process.platform}-${process.arch}`];

function findSgBinary() {
  const bin = process.platform === "win32" ? "sg.exe" : "sg";
  for (const name of ["@ast-grep/cli", AST_GREP_PLATFORM_PKG]) {
    if (!name) continue;
    const dir = packageRoot(name);
    if (dir && existsSync(join(dir, bin))) return join(dir, bin);
  }
  return null;
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

const hostRoot = packageRoot("@earendil-works/pi-coding-agent");
const pi = hostRoot && join(hostRoot, "dist", "bundle", "cli.js");
if (!pi || !existsSync(pi)) {
  console.error(
    "sensei: pi host not installed. Reinstall sensei, or run `npm install` in the sensei repo.",
  );
  process.exit(1);
}

// Point extensions at the vendored ast-grep binary when it's installed.
const sg = process.env.SENSEI_SG_PATH || findSgBinary();
const sgEnv = sg && existsSync(sg) ? { SENSEI_SG_PATH: sg } : {};

const res = spawnSync(process.execPath, [pi, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    SENSEI_AGENT_DIR: agentDir,
    SENSEI_REPO_ROOT: root,
    SENSEI_PI_BIN: pi,
    SENSEI_VERSION: readVersion(join(root, "package.json")),
    SENSEI_HOST_VERSION: readVersion(join(hostRoot, "package.json")),
    ...sgEnv,
  },
});
process.exit(res.status ?? 1);
