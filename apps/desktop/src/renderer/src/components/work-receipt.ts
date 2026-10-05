import type { Block } from "../lib/transcript";
import { editedPaths } from "../lib/edited-paths";
import { commandText } from "./work-chips";

/** The checks an agent runs to prove its work, most telling first when one command runs several. */
const checks: [label: string, pattern: RegExp][] = [
  ["tests", /\b(vitest|jest|pytest|mocha|go test|cargo test)\b|\b(npm|pnpm|yarn|bun)\b[^|;&\n]*\btest\b/],
  ["typecheck", /\b(tsc|typecheck|mypy|pyright)\b/],
  ["lint", /\b(eslint|ruff|clippy|golangci-lint)\b|\b(npm|pnpm|yarn|bun)\b[^|;&\n]*\blint\b/],
  ["build", /\b(cargo build|go build|vite build|astro build|next build)\b|\b(npm|pnpm|yarn|bun)\b[^|;&\n]*\bbuild\b/],
];

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
