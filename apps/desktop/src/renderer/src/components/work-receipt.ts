import type { Block } from "../lib/transcript";
import { editedPaths } from "../lib/edited-paths";
import { workDuration } from "../lib/work-transcript";
import { commandText } from "./work-chips";

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

/** One item of a turn's receipt row: how long it thought, how many steps it took, and the last check it ran. */
export interface ReceiptItem {
  kind: "thought" | "steps" | "check";
  label: string;
  failed?: boolean;
}

/** How long the turn spent reasoning, summed over its thinking blocks; "Thinking" while one still runs. */
function thoughtLabel(blocks: Block[]): string | null {
  const thoughts = blocks.filter((block): block is Extract<Block, { kind: "thinking" }> => block.kind === "thinking");
  if (!thoughts.length) return null;
  if (thoughts.some((block) => block.endedAt === null)) return "Thinking";
  const ms = thoughts.reduce((sum, block) => sum + Math.max(0, (block.endedAt ?? block.startedAt) - block.startedAt), 0);
  return `Thought ${workDuration(Math.max(1000, ms))}`;
}

/** The receipt under a turn's head. The duration is the head's; a check only reads once the turn is over. */
export function receiptItems(blocks: Block[], steps: number, live: boolean): ReceiptItem[] {
  const items: ReceiptItem[] = [];
  const thought = thoughtLabel(blocks);
  if (thought) items.push({ kind: "thought", label: thought });
  if (steps) items.push({ kind: "steps", label: `${steps} ${steps === 1 ? "step" : "steps"}` });
  const check = live ? null : lastCheck(blocks);
  if (check) items.push({ kind: "check", label: check, failed: check.endsWith("failed") });
  return items;
}
