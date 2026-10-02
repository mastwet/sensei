// sensei core extension — wires all owned features into the pi host.
// Loaded by the pinned pi host from the sensei agent dir.
import astgrep from "./astgrep.ts";
import banner from "./banner.ts";
import bashtimeout from "./bashtimeout.ts";
import btw from "./btw.ts";
import council from "./council.ts";
import delegate from "./delegate.ts";
import goal from "./goal.ts";
import historySearch from "./history.ts";
import jsonerror from "./jsonerror.ts";
import lookAt from "./lookat.ts";
import loop from "./loop.ts";
import loopguard from "./loopguard.ts";
import nestedagents from "./nestedagents.ts";
import preset from "./preset.ts";
import rules from "./rules.ts";
import todo from "./todo.ts";
import videoin from "./videoin.ts";
import waitfor from "./waitfor.ts";
import webfetch from "./webfetch.ts";
import websearch from "./websearch.ts";
import work from "./work.ts";

export default function (pi: any) {
  rules(pi); // first: owns before_agent_start system-prompt section
  preset(pi); // appends after rules
  bashtimeout(pi); // appends timeout policy after preset
  banner(pi); // TUI header identity
  goal(pi); // before work: goal continuation takes precedence at settle
  delegate(pi);
  astgrep(pi);
  todo(pi);
  webfetch(pi);
  websearch(pi);
  historySearch(pi);
  btw(pi);
  council(pi);
  lookAt(pi);
  videoin(pi);
  loop(pi);
  loopguard(pi); // tool-loop detection + veto
  nestedagents(pi); // AGENTS.md injection on read results
  jsonerror(pi); // JSON parse-error retry reminder on tool results
  waitfor(pi); // wait_for_user tool
  work(pi); // last: yields to an active goal

  pi.registerCommand("sensei", {
    description: "Show sensei status",
    handler: async (_args: string, ctx: any) => {
      ctx.ui.notify(
        "sensei loaded: banner, delegate, work, todo, webfetch, web_search, history_search, btw, look_at, rules, preset, loop, goal, loopguard, nestedagents, videoin, bashtimeout, ast_grep, council, jsonerror, wait_for_user",
        "info",
      );
    },
  });
}
