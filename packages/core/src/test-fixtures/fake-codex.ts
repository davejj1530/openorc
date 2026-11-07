/**
 * Stands in for Codex where a move proves a session resumes: `--version`, and an app server that resumes a thread
 * only when its rollout is in CODEX_HOME, as Codex refuses one it cannot find.
 */
export const FAKE_CODEX_RESUME = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli 0.166.0"); process.exit(0); }
const home = process.env.CODEX_HOME || path.join(process.env.HOME, ".codex");
const found = (id) => {
  const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).flatMap((name) => (fs.statSync(path.join(dir, name)).isDirectory() ? walk(path.join(dir, name)) : [name])) : []);
  return walk(path.join(home, "sessions")).some((name) => name.endsWith("-" + id + ".jsonl"));
};
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const reply = (body) => process.stdout.write(JSON.stringify({ id: message.id, ...body }) + "\\n");
  if (message.method !== "thread/resume") return reply({ result: {} });
  if (!found(message.params.threadId)) return reply({ error: { code: -32600, message: "no rollout found for thread id " + message.params.threadId } });
  reply({ result: { thread: { id: message.params.threadId } } });
});
`;
