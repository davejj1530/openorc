import type { Autorun, DiffMode } from "../shared/types";

const diffModes: DiffMode[] = ["main", "worker", "plain"];
const routeArgument = "--openorc-route=";

/**
 * The launch switches the renderer reads once at startup. Environment switches exist for QA builds only, so a
 * release build reads none of them and no environment variable can make it run, approve or display anything on
 * its own. The route argument stays in every build: the main process passes it when it opens a second window.
 */
export function readAutorun(env: NodeJS.ProcessEnv, argv: readonly string[], qa: boolean): Autorun {
  const qaEnv: NodeJS.ProcessEnv = qa ? env : {};
  return {
    bench: qaEnv["OPENORC_AUTOBENCH"] === "1",
    threadBench: qaEnv["OPENORC_AUTOBENCH_THREAD"] === "1",
    codex: qaEnv["OPENORC_AUTORUN_CODEX"] === "1",
    thread: qaEnv["OPENORC_AUTORUN_THREAD"] === "1",
    cwd: qaEnv["OPENORC_AUTORUN_CWD"] ?? null,
    prompt: qaEnv["OPENORC_AUTORUN_PROMPT"] ?? null,
    agent: qaEnv["OPENORC_AUTORUN_AGENT"] ?? null,
    model: qaEnv["OPENORC_AUTORUN_MODEL"] ?? null,
    image: qaEnv["OPENORC_AUTORUN_IMAGE"] ?? null,
    diff: qaEnv["OPENORC_AUTODIFF"] === "1",
    diffMode: diffModes.find((m) => m === qaEnv["OPENORC_AUTODIFF_MODE"]) ?? "main",
    route: qaEnv["OPENORC_ROUTE"] ?? argv.find((a) => a.startsWith(routeArgument))?.slice(routeArgument.length) ?? null,
    theme: requestedTheme(qaEnv["OPENORC_THEME"]),
  };
}

function requestedTheme(value: string | undefined): "dark" | "light" | null {
  if (value === "dark" || value === "light") return value;
  return null;
}
