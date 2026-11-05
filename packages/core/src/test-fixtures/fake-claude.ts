import { existsSync, readFileSync } from "node:fs";

/**
 * Stands in for Claude Code on this Mac and in the sandbox. Like the CLI, it keeps each session in its config folder
 * under the folder it runs in, and refuses to resume a session that is not there. Each turn appends to FAKE_LOG.
 */
export const FAKE_CLAUDE = `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("2.1.316 (Claude Code)");
  process.exit(0);
}
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const resume = flag("--resume");
const id = resume ?? flag("--session-id") ?? "fresh-session";
const config = process.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.HOME, ".claude");
const file = path.join(config, "projects", process.cwd().replace(/[^A-Za-z0-9]/g, "-"), id + ".jsonl");
if (resume && !existsSync(file)) {
  console.error("No conversation found with session ID: " + resume);
  process.exit(1);
}
const earlier = existsSync(file) ? readFileSync(file, "utf8").trim().split("\\n").length : 0;
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const prompt = JSON.parse(line).message.content[0].text;
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({ type: "user", cwd: process.cwd(), sessionId: id, prompt }) + "\\n");
  appendFileSync(process.env.FAKE_LOG, JSON.stringify({ cwd: process.cwd(), id, resumed: Boolean(resume), earlier, prompt }) + "\\n");
  emit({ type: "system", subtype: "init", session_id: id, model: "fixture", tools: [] });
  emit({ type: "assistant", message: { id: "m-" + Date.now(), role: "assistant", content: [{ type: "text", text: "Done" }], usage: { input_tokens: 1, output_tokens: 1 } } });
  emit({ type: "result", subtype: "success", is_error: false, duration_ms: 5, num_turns: 1, total_cost_usd: 0, result: "Done", usage: { input_tokens: 1, output_tokens: 1 } });
});
`;

export interface Turn {
  cwd: string;
  id: string;
  resumed: boolean;
  earlier: number;
  prompt: string;
}

/** The turns the fake has taken, from its log. */
export const turnsIn = (log: string): Turn[] =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Turn)
    : [];

export async function until(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
