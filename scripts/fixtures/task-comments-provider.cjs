/** Deterministic local provider for the task-comments native smoke; no network except local MCP. */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const directory = process.env.OPENORC_QA_PROVIDER_DIR;
if (!directory || !path.basename(directory).startsWith("openorc-workflow-qa-")) throw Error("Disposable fixture required");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("codex-cli 1.0.0");
  process.exit(0);
}
if (args.includes("status")) {
  console.log(args.includes("auth") ? JSON.stringify({ loggedIn: true }) : "Logged in using ChatGPT");
  process.exit(0);
}
if (args[0] !== "app-server") process.exit(1);
const setting = args.find((value) => /^mcp_servers\.[^.]+\.url=/.test(value));
const url = setting ? JSON.parse(setting.slice(setting.indexOf("=") + 1)) : null;
if (url && !/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[\w-]+$/.test(url)) throw Error("Local MCP only");
const send = (data) => process.stdout.write(JSON.stringify(data) + "\n");
const notify = (method, params) => send({ method, params });
let sessionId = randomUUID(),
  resumed = false,
  instructions = "",
  turnId;
async function tool(name, input) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: input } }),
  });
  const raw = await r.text();
  const payload = JSON.parse(
    raw.startsWith("{")
      ? raw
      : raw
          .split("\n")
          .find((l) => l.startsWith("data: "))
          .slice(6),
  );
  if (payload.error || payload.result?.isError) throw Error(JSON.stringify(payload));
}
async function respond(prompt) {
  if (!fs.realpathSync(process.cwd()).startsWith(fs.realpathSync(directory) + path.sep)) throw Error("Disposable workspace required");
  const discussion = instructions.includes("You are responding in task comments.");
  const latest = prompt.split("Latest user request:\n").at(-1);
  const work = discussion && latest.includes("Implement this now");
  fs.appendFileSync(path.join(directory, "comment-provider.jsonl"), JSON.stringify({ discussion, work, prompt, sessionId, resumed }) + "\n");
  if (discussion) await tool("task_comment_intent", { intent: work ? "execution" : "discussion", quote: work ? "Implement this now" : "" });
  const text = responseText(discussion, work);
  const id = randomUUID();
  notify("item/started", { turnId, item: { type: "agentMessage", id, text: "" } });
  for (const chunk of text.match(/.{1,28}/g)) {
    notify("item/agentMessage/delta", { turnId, itemId: id, delta: chunk });
    await new Promise((r) => setTimeout(r, 40));
  }
  notify("item/completed", { turnId, item: { type: "agentMessage", id, text } });
  notify("turn/completed", { turn: { id: turnId, status: "completed", durationMs: 400 } });
}
require("node:readline")
  .createInterface({ input: process.stdin })
  .on("line", (line) => {
    const q = JSON.parse(line);
    if (q.id === undefined) return;
    if (q.method === "initialize") return send({ id: q.id, result: { userAgent: "task-comments-fixture" } });
    if (q.method === "config/read") return send({ id: q.id, result: { config: { mcp_servers: {} } } });
    if (q.method === "model/list")
      return send({
        id: q.id,
        result: {
          data: [
            {
              id: "fixture",
              model: "fixture",
              displayName: "Fixture",
              isDefault: true,
              supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
              defaultReasoningEffort: "high",
            },
          ],
        },
      });
    if (q.method === "thread/start" || q.method === "thread/resume") {
      resumed = q.method === "thread/resume";
      if (resumed) sessionId = q.params.threadId;
      instructions = q.params.developerInstructions ?? "";
      return send({ id: q.id, result: { thread: { id: sessionId }, model: q.params.model } });
    }
    if (q.method === "turn/start") {
      turnId = randomUUID();
      send({ id: q.id, result: { turn: { id: turnId } } });
      notify("turn/started", { turn: { id: turnId } });
      void respond(
        (q.params.input ?? [])
          .filter((x) => x.type === "text")
          .map((x) => x.text)
          .join("\n"),
      ).catch((e) => {
        console.error(e);
        process.exit(1);
      });
      return;
    }
    if (q.method === "turn/interrupt") {
      send({ id: q.id, result: {} });
      process.exit(0);
    }
    send({ id: q.id, result: {} });
  });
setTimeout(() => process.exit(1), 120000).unref();

function responseText(discussion, work) {
  if (!discussion) return "Implemented and verified in the disposable workspace.";
  if (work) return "I’ll hand this implementation request to the linked thread.";
  return "Keep comments on the task, with a separate read-only response for each tagged agent. Use the linked thread when you ask for implementation.";
}
