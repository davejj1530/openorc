import type { Block } from "./transcript.js";
import { editedPaths } from "./edited-paths.js";
import { workDuration } from "./work-transcript.js";
import { commandText } from "./work-chips.js";
import { workObjects, type EditObject, type GitObject, type TestsObject, type WorkObject } from "./work-objects.js";
import { objectOutcome } from "./work-outcomes.js";

/** The checks an agent runs to prove its work, most telling first when one command runs several. */
const checks: [label: string, pattern: RegExp][] = [
  ["tests", /\b(vitest|jest|pytest|mocha|go test|cargo test)\b|\b(npm|pnpm|yarn|bun)\b[^|;&\n]*\btest\b/],
  ["typecheck", /\b(tsc|typecheck|mypy|pyright)\b/],
  ["lint", /\b(eslint|ruff|clippy|golangci-lint)\b|\b(npm|pnpm|yarn|bun)\b[^|;&\n]*\blint\b/],
  ["build", /\b(cargo build|go build|vite build|astro build|next build)\b|\b(npm|pnpm|yarn|bun)\b[^|;&\n]*\bbuild\b/],
];

/** A command that checks the work: tests, a typecheck, lint or a build. */
export function isCheckCommand(command: string): boolean {
  return checks.some(([, pattern]) => pattern.test(command));
}

/** A pipe hands the exit code to its last command, so `pnpm test | tail` succeeds whatever the tests did. */
function piped(command: string): boolean {
  return /(^|[^|])\|([^|]|$)/.test(command.replace(/'[^']*'|"[^"]*"/g, ""));
}

/** The last check the turn ran: "tests passed", "typecheck failed", or "tests ran" when the result was piped away. */
function lastCheck(blocks: Block[]): string | null {
  for (const block of [...blocks].reverse()) {
    if (block.kind !== "tool" || !block.done) continue;
    const command = commandText(block);
    const check = command ? checks.find(([, pattern]) => pattern.test(command)) : undefined;
    if (!check) continue;
    if (piped(command)) return `${check[0]} ran`;
    return `${check[0]} ${block.isError ? "failed" : "passed"}`;
  }
  return null;
}

/** What a finished turn came to, in a few words: "2 files changed", "tests passed". Empty when it changed and checked nothing. */
export function turnReceipt(blocks: Block[]): string[] {
  const paths = new Set(blocks.flatMap((block) => (block.kind === "tool" && block.done && !block.isError ? editedPaths(block.name, block.input) : [])));
  const check = lastCheck(blocks);
  return [paths.size ? `${paths.size} file${paths.size === 1 ? "" : "s"} changed` : "", check ?? ""].filter(Boolean);
}

/**
 * One item of a turn's receipt row: how long it thought, then what it came to (the pull request it opened, the size
 * of its changes, its last tests or check), or how many steps it took when it came to none of those.
 */
export interface ReceiptItem {
  kind: "thought" | "steps" | "check" | "tests" | "git" | "changes" | "agents" | "sources";
  label: string;
  failed?: boolean;
}

/** The size the turn's change card reads, from the checkpoint it saved. */
export interface TurnSize {
  files: number;
  added: number;
  removed: number;
}

/** How long the turn spent reasoning, summed over its thinking blocks; "Thinking" while one still runs. */
function thoughtLabel(blocks: Block[]): string | null {
  const thoughts = blocks.filter((block): block is Extract<Block, { kind: "thinking" }> => block.kind === "thinking");
  if (!thoughts.length) return null;
  if (thoughts.some((block) => block.endedAt === null)) return "Thinking";
  const ms = thoughts.reduce((sum, block) => sum + Math.max(0, (block.endedAt ?? block.startedAt) - block.startedAt), 0);
  return `Thought ${workDuration(Math.max(1000, ms))}`;
}

function gitItem(objects: WorkObject[]): ReceiptItem | null {
  const git = objects.findLast((object): object is GitObject => object.kind === "git");
  if (!git) return null;
  if (git.pullRequest?.number && git.pullRequest.state !== "failed") return { kind: "git", label: `#${git.pullRequest.number} open` };
  const outcome = objectOutcome(git);
  return outcome ? { kind: "git", label: outcome.text, failed: outcome.failed } : null;
}

/** "+21 −8 in 3 files": the checkpoint's numbers once the turn saved one, the edits' own until then. */
function changesItem(objects: WorkObject[], size: TurnSize | null): ReceiptItem | null {
  const edits = objects.filter((object): object is EditObject => object.kind === "edit" && object.state !== "failed");
  const counted = size ?? {
    files: new Set(edits.map((edit) => edit.chip.key)).size,
    added: edits.reduce((sum, edit) => sum + (edit.chip.added ?? 0), 0),
    removed: edits.reduce((sum, edit) => sum + (edit.chip.removed ?? 0), 0),
  };
  if (!counted.files) return null;
  const lines = [counted.added || !counted.removed ? `+${counted.added}` : "", counted.removed ? `−${counted.removed}` : ""].filter(Boolean).join(" ");
  return { kind: "changes", label: `${lines} in ${counted.files} ${counted.files === 1 ? "file" : "files"}` };
}

/**
 * The last tests the turn ran, counted when the runner said, and the last other check in words when there were no
 * counted tests or it failed: "12 passed", "typecheck failed".
 */
function checkItems(blocks: Block[], objects: WorkObject[]): ReceiptItem[] {
  const check = lastCheck(blocks);
  const tests = objects.findLast((object): object is TestsObject => object.kind === "tests" && (object.state === "done" || object.state === "failed") && object.run !== null);
  const outcome = tests ? objectOutcome(tests) : null;
  const items: ReceiptItem[] = outcome ? [{ kind: "tests", label: outcome.text, failed: outcome.failed }] : [];
  const counted = outcome && check?.startsWith("tests");
  if (check && !counted && (!outcome || check.endsWith("failed"))) items.push({ kind: "check", label: check, failed: check.endsWith("failed") });
  return items;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The agents the turn started and the pages it read, for a turn that came to findings rather than changes. */
function lookedItems(blocks: Block[], objects: WorkObject[]): ReceiptItem[] {
  const agents = blocks.filter((block) => block.kind === "tool" && block.subagent).length;
  const urls = objects.flatMap((object) => {
    if (object.kind === "fetch") return [object.url];
    return object.kind === "web" ? object.links.slice(0, 3).map((link) => link.url) : [];
  });
  const sources = new Set(urls).size;
  return [...(agents ? [{ kind: "agents" as const, label: plural(agents, "agent") }] : []), ...(sources ? [{ kind: "sources" as const, label: plural(sources, "source") }] : [])];
}

/**
 * The receipt under a turn's head. The duration is the head's. While the turn runs it says what it has come to so
 * far; a check only reads once the turn is over. `size` is the turn's saved change, when it has one.
 */
export function receiptItems(blocks: Block[], steps: number, live: boolean, size: TurnSize | null = null): ReceiptItem[] {
  const items: ReceiptItem[] = [];
  const thought = thoughtLabel(blocks);
  if (thought) items.push({ kind: "thought", label: thought });
  const objects = workObjects(blocks, blocks, live);
  const outcomes = [gitItem(objects), changesItem(objects, size), ...(live ? [] : checkItems(blocks, objects))].filter((item): item is ReceiptItem => item !== null);
  if (!outcomes.length) outcomes.push(...lookedItems(blocks, objects));
  if (outcomes.length) items.push(...outcomes);
  else if (steps) items.push({ kind: "steps", label: `${steps} ${steps === 1 ? "step" : "steps"}` });
  return items;
}
