import { z } from "zod";
import { testRun, type TestRun } from "./test-run.js";

const HEAD_LINES = 6;
const TAIL_LINES = 4;
const LINE_CHARS = 200;
const LINKS = 5;

const TestRunSchema = z.object({
  runner: z.enum(["vitest", "jest", "pytest", "cargo", "go"]),
  passed: z.number(),
  failed: z.number(),
  skipped: z.number(),
  finished: z.boolean(),
  failures: z.array(z.object({ name: z.string(), file: z.string().nullable(), message: z.string() })),
  durationMs: z.number().nullable(),
  cases: z.array(z.enum(["passed", "failed", "skipped"])),
}) satisfies z.ZodType<TestRun>;

/** `git commit` printing "[branch abc1234] subject". */
const GitCommitMade = z.object({ branch: z.string(), sha: z.string(), subject: z.string() });
export type GitCommitMade = z.infer<typeof GitCommitMade>;

/** One ref line of `git push`: "   89a9ed1..4f2a9c1  main -> main", "* [new branch] a -> a", "! [rejected] …". */
const GitPushed = z.object({
  remote: z.string().nullable(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  source: z.string(),
  target: z.string(),
  created: z.boolean(),
  rejected: z.boolean(),
});
export type GitPushed = z.infer<typeof GitPushed>;

const GitDigest = z.object({
  commits: z.array(GitCommitMade),
  pushes: z.array(GitPushed),
  pullRequest: z.object({ url: z.string(), number: z.number() }).nullable(),
});
export type GitDigest = z.infer<typeof GitDigest>;

const WebLink = z.object({ title: z.string(), url: z.string() });
export type WebLink = z.infer<typeof WebLink>;

/**
 * What a tool's output came to, small enough to keep when a transcript page leaves the output itself out: its
 * first and last lines, and what a test runner, Git or a web search printed. The core saves it on a large result;
 * a reader with the output in hand makes the same thing from it, so both read one shape.
 */
export const ToolDigest = z.object({
  /** How many lines it printed, blank ones aside. */
  lines: z.number(),
  head: z.array(z.string()),
  tail: z.array(z.string()),
  tests: TestRunSchema.optional(),
  git: GitDigest.optional(),
  links: z.array(WebLink).optional(),
});
export type ToolDigest = z.infer<typeof ToolDigest>;

function partText(part: unknown): string {
  if (typeof part === "string") return part;
  const text = (part as { text?: unknown } | null)?.text;
  return typeof text === "string" ? text : "";
}

/** A tool's output as text: a string, MCP-style content parts, or anything else as JSON. */
export function toolOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output.map(partText).join("\n");
  const envelope = (output as { content?: unknown } | null)?.content;
  if (Array.isArray(envelope)) return envelope.map(partText).join("\n");
  if (output === undefined || output === null) return "";
  try {
    return JSON.stringify(output) ?? "";
  } catch {
    return "";
  }
}

const COMMIT = /^\[(.+?)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.+)$/;
const PUSH_TO = /^To (\S+)$/;
const PUSH_REF = /^\s*([ +*!=-])\s+(\[new branch\]|\[new tag\]|\[rejected\]|\[remote rejected\]|\[up to date\]|([0-9a-f]{7,40})\.{2,3}([0-9a-f]{7,40}))\s+(\S+) -> (\S+)/;
/** GitHub's and GitHub Enterprise's pull request links: `https://<host>/<owner>/<repo>/pull/<n>`. */
const PULL_REQUEST = /https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/;

function gitDigest(lines: string[]): GitDigest | undefined {
  const commits: GitCommitMade[] = [];
  const pushes: GitPushed[] = [];
  let remote: string | null = null;
  let pullRequest: GitDigest["pullRequest"] = null;
  for (const line of lines) {
    const commit = COMMIT.exec(line);
    if (commit) commits.push({ branch: commit[1]!, sha: commit[2]!, subject: commit[3]!.trim() });
    remote = PUSH_TO.exec(line)?.[1] ?? remote;
    // A push cut by `tail` may have lost its "To" line; its ref lines still say what happened.
    const ref = PUSH_REF.exec(line);
    if (ref)
      pushes.push({
        remote,
        from: ref[3] ?? null,
        to: ref[4] ?? null,
        source: ref[5]!,
        target: ref[6]!,
        created: ref[2] === "[new branch]" || ref[2] === "[new tag]",
        rejected: ref[1] === "!",
      });
    const pull: RegExpExecArray | null = pullRequest ? null : PULL_REQUEST.exec(line);
    if (pull) pullRequest = { url: pull[0], number: Number(pull[1]) };
  }
  return commits.length || pushes.length || pullRequest ? { commits, pushes, pullRequest } : undefined;
}

/** Claude's web search prints its results as one `Links: [{"title","url"}, …]` line. */
function webLinks(text: string): WebLink[] | undefined {
  const line = /^Links: (\[.*\])\s*$/m.exec(text)?.[1];
  if (!line) return undefined;
  try {
    const parsed = WebLink.array().safeParse(JSON.parse(line));
    return parsed.success && parsed.data.length ? parsed.data.slice(0, LINKS) : undefined;
  } catch {
    return undefined;
  }
}

const cut = (line: string) => (line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS - 1)}…` : line);

/** The digest of a tool's output, or null when it printed nothing. */
export function toolDigest(output: unknown): ToolDigest | null {
  const text = toolOutputText(output);
  if (!text.trim()) return null;
  // eslint-disable-next-line no-control-regex
  const lines = text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").split(/\r?\n/);
  const printed = lines.map((line) => line.replace(/^.*\r/, "").trimEnd()).filter((line) => line.trim());
  const tests = testRun(text) ?? undefined;
  const git = gitDigest(printed);
  const links = webLinks(text);
  return {
    lines: printed.length,
    head: printed.slice(0, HEAD_LINES).map(cut),
    tail: printed.length > HEAD_LINES ? printed.slice(Math.max(HEAD_LINES, printed.length - TAIL_LINES)).map(cut) : [],
    ...(tests ? { tests } : {}),
    ...(git ? { git } : {}),
    ...(links ? { links } : {}),
  };
}
