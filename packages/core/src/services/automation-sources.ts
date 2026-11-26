import { GitError, run } from "@openorc/git";

/** A pull request as an automation reads it: who opened it, its branch and newest commit, and how that commit's checks came out. */
export type Pull = {
  number: number;
  title: string;
  url: string;
  branch: string;
  sha: string;
  author: string;
  /** The checks that failed on its newest commit, by name. */
  failed: string[];
  /** Whether every check on its newest commit has finished. */
  settled: boolean;
};

/** Where automations read what happened outside the app. Tests stand in for it. */
export interface AutomationSources {
  /** The project's open pull requests, or the ones merged most lately. */
  pulls(cwd: string, state: "open" | "merged"): Promise<Pull[]>;
  /** A check's command run in the project folder: the lines it printed. A command that fails says why. */
  check(cwd: string, command: string): Promise<string[]>;
}

/** One line a check printed: what comes before a tab tells one thing from another, and the rest describes it. A line without a tab is both. */
export function checkFinding(line: string): { id: string; words: string } {
  const tab = line.indexOf("\t");
  return tab > 0 ? { id: line.slice(0, tab), words: line.slice(tab + 1).trim() } : { id: line, words: line };
}

const FAILED = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ERROR"]);
const RUNNING = new Set(["PENDING", "EXPECTED"]);
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** GitHub lists two kinds of check: a run, finished once its status says so, and a status another service set. */
function checks(rollup: unknown): Pick<Pull, "failed" | "settled"> {
  const failed: string[] = [];
  let settled = true;
  for (const item of Array.isArray(rollup) ? (rollup as Record<string, unknown>[]) : []) {
    const isRun = item.__typename === "CheckRun";
    if (isRun ? item.status !== "COMPLETED" : RUNNING.has(text(item.state))) settled = false;
    else if (FAILED.has(text(isRun ? item.conclusion : item.state))) failed.push(text(item.name) || text(item.context) || "A check");
  }
  return { failed, settled };
}

function pullOf(item: Record<string, unknown>): Pull | null {
  if (typeof item.number !== "number" || typeof item.url !== "string") return null;
  const author = item.author && typeof item.author === "object" ? text((item.author as { login?: unknown }).login) : "";
  return { number: item.number, title: text(item.title), url: item.url, branch: text(item.headRefName), sha: text(item.headRefOid), author, ...checks(item.statusCheckRollup) };
}

/** The pull requests in what `gh pr list --json` printed. One without a number or an address is left out. */
export function pullsFrom(printed: string): Pull[] {
  const listed: unknown = JSON.parse(printed);
  return (Array.isArray(listed) ? (listed as Record<string, unknown>[]) : []).map(pullOf).filter((pull): pull is Pull => pull !== null);
}

/** Why a command did not answer, for the person: what could not be done, and the last thing the command said, or that it ran out of time. */
function failure(what: string, error: unknown): Error {
  if (!(error instanceof GitError)) return error instanceof Error ? error : new Error(String(error));
  const said = error.stderr.trim().split("\n").at(-1);
  if (error.code === null && !said) return new Error(`${what}: it did not finish in time.`);
  return new Error(said ? `${what}: ${said}` : `${what}.`);
}

const FIELDS = "number,title,url,headRefName,headRefOid,author";
/** A check that prints without end is cut off here; what it printed past this is not read. */
const LINES = 200;
const LINE = 500;

export const liveAutomationSources: AutomationSources = {
  async pulls(cwd, state) {
    // Open ones come with their checks. Merged ones are asked for by when they last changed, so one that just merged leads.
    const args =
      state === "open" ? ["--state", "open", "--limit", "100", "--json", `${FIELDS},statusCheckRollup`] : ["--state", "merged", "--limit", "30", "--search", "sort:updated-desc", "--json", FIELDS];
    const result = await run("gh", cwd, ["pr", "list", ...args], { timeoutMs: 30_000 }).catch((error: unknown) => {
      throw failure("GitHub's pull requests could not be read", error);
    });
    return pullsFrom(result.stdout);
  },
  async check(cwd, command) {
    // A login shell, as the project's setup script runs in, so the command finds the tools the person's terminal does.
    const result = await run("/bin/bash", cwd, ["-lc", command], { timeoutMs: 60_000, maxBuffer: 1024 * 1024 }).catch((error: unknown) => {
      throw failure("Its check did not run", error);
    });
    return result.stdout
      .split("\n")
      .map((line) => line.trim().slice(0, LINE))
      .filter(Boolean)
      .slice(0, LINES);
  },
};
