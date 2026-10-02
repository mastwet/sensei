// banner — sensei's identity in the TUI header.
//
// pi hides its startup output behind `quietStartup`, which left the TUI opening on
// a blank screen with no hint of what was running. This extension owns a compact
// header instead: line 1 says what this is, line 2 says what it is running against,
// line 3 (wide terminals only) keeps the command hints that replacing the built-in
// logo header would otherwise drop. `/banner` cycles sensei -> built-in.
//
// Dependency-free by design (see README): no imports from the host package, so a
// host upgrade can never break this extension. That rules out pi-tui's
// truncateToWidth(), so span fitting is hand-rolled below. Every string here is
// ASCII except the fixed glyphs BAR ("▌") and SEP ("·"), both of which occupy
// exactly one terminal column, so string length still matches display width.

type Span = { text: string; color?: string; bold?: boolean };
type BannerMode = "sensei" | "builtin";

const BAR = "▌ ";
const SEP = " · ";
const TAGLINE = "stability-first, self-maintained coding agent";
const HINTS = "/work <goal> run until done · /sensei status · /rules · /preset · /banner";
// Narrower than this and the hint line would crowd out the facts instead of adding to them.
const MIN_HINT_WIDTH = 64;

function style(theme: any, span: Span, text: string): string {
  if (!text) return "";
  let out = span.color ? theme.fg(span.color, text) : text;
  if (span.bold) out = theme.bold(out);
  return out;
}

// Joins spans into one line, never exceeding `width` columns. The first span that
// overflows is clipped and gets a one-column ellipsis; the rest are dropped.
function renderSpans(theme: any, spans: Span[], width: number): string {
  let out = "";
  let used = 0;
  for (const span of spans) {
    if (used >= width) break;
    let text = span.text;
    const room = width - used;
    if (text.length > room) text = room > 1 ? text.slice(0, room - 1) + "…" : "";
    used += text.length;
    out += style(theme, span, text);
  }
  return out;
}

function line(theme: any, spans: Span[], width: number): string {
  return theme.fg("accent", BAR) + renderSpans(theme, spans, Math.max(0, width - BAR.length));
}

function titleSpans(): Span[] {
  return [
    { text: `sensei v${process.env.SENSEI_VERSION || "?"}`, color: "accent", bold: true },
    { text: `  ${TAGLINE}`, color: "muted" },
  ];
}

// Facts about this run. ctx.model is read per render so the header keeps up with
// /model switches; everything else is fixed for the life of the process.
function factSpans(ctx: any): Span[] {
  const facts: Span[] = [];

  const host = process.env.SENSEI_HOST_VERSION;
  if (host && host !== "unknown") facts.push({ text: `pi host ${host}`, color: "dim" });

  const model = ctx?.model;
  const name = model?.name || model?.id;
  if (name) facts.push({ text: model.provider ? `${name} @ ${model.provider}` : name, color: "dim" });

  if (ctx?.cwd) facts.push({ text: baseName(ctx.cwd), color: "dim" });

  const dir = process.env.SENSEI_AGENT_DIR || process.env.PI_CODING_AGENT_DIR;
  if (dir) facts.push({ text: tilde(dir), color: "dim" });

  const spans: Span[] = [];
  facts.forEach((fact, i) => {
    if (i > 0) spans.push({ text: SEP, color: "borderMuted" });
    spans.push(fact);
  });
  return spans;
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

function tilde(p: string): string {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  if (home && p.toLowerCase().startsWith(home.toLowerCase())) return "~" + p.slice(home.length);
  return p;
}

function component(theme: any, ctx: any) {
  return {
    render(width: number): string[] {
      const w = Math.max(20, width);
      const rows = ["", line(theme, titleSpans(), w), line(theme, factSpans(ctx), w)];
      if (w >= MIN_HINT_WIDTH) rows.push(line(theme, [{ text: HINTS, color: "borderMuted" }], w));
      return rows;
    },
    invalidate() {},
  };
}

export default function banner(pi: any): void {
  // SENSEI_BANNER=builtin starts on pi's own header instead of sensei's.
  let mode: BannerMode = process.env.SENSEI_BANNER === "builtin" ? "builtin" : "sensei";
  // Remembered so /banner can redraw without waiting for a reload.
  let lastCtx: any = null;

  // setHeader(undefined) restores pi's built-in logo + keybinding header, so both
  // modes go through this one call.
  const apply = () => {
    if (lastCtx?.mode !== "tui") return;
    lastCtx.ui.setHeader(
      mode === "builtin" ? undefined : (_tui: any, theme: any) => component(theme, lastCtx),
    );
  };

  pi.on("session_start", async (_event: any, ctx: any) => {
    lastCtx = ctx;
    apply();
  });

  pi.registerCommand("banner", {
    description: "Toggle the sensei startup banner (sensei | builtin)",
    handler: async (args: string, ctx: any) => {
      const want = String(args ?? "").trim().toLowerCase();
      if (want === "sensei" || want === "builtin") mode = want;
      else mode = mode === "sensei" ? "builtin" : "sensei";

      if (ctx?.mode !== "tui") {
        ctx?.ui?.notify?.("banner is a TUI-only feature", "warning");
        return;
      }
      lastCtx = ctx;
      apply();
      ctx.ui.notify(mode === "sensei" ? "sensei banner on" : "built-in header restored", "info");
    },
  });
}
