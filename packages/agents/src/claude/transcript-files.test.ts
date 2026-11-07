import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentEvent } from "@openorc/protocol";
import { ClaudeStreamParser } from "./stream-json.js";
import { ClaudeTranscriptFiles } from "./transcript-files.js";
import fixture from "./test-fixtures/workflows.json";
import nested from "./test-fixtures/nested-transcript.json";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const assistant = (uuid: string, text: string) => ({ type: "assistant", uuid, message: { id: "shared-message", content: [{ type: "text", text }] } });
async function setup(beforeEmit: (event: AgentEvent) => void = () => {}) {
  const config = await mkdtemp(path.join(tmpdir(), "workflow-account-"));
  const parser = new ClaudeStreamParser("host-run");
  const progress = (state: string) =>
    parser.parseLine(line({ type: "system", subtype: "task_progress", task_id: "task", workflow_progress: [{ type: "workflow_agent", index: 1, agentId: "agent-1", state }] }));
  parser.parseLine(line({ type: "system", subtype: "init", session_id: "observed-session" }));
  parser.parseLine(line({ type: "system", subtype: "task_started", task_type: "local_workflow", task_id: "task", tool_use_id: "workflow" }));
  progress("start");
  const events: AgentEvent[] = [];
  const files = new ClaudeTranscriptFiles(
    parser,
    config,
    (event) => {
      beforeEmit(event);
      events.push(event);
    },
    20,
  );
  const folder = path.join(config, "projects", "different-project-key", "observed-session", "subagents", "workflows", "wf-example");
  const file = path.join(folder, "agent-agent-1.jsonl");
  cleanups.push(async () => {
    await files.close();
    await rm(config, { recursive: true, force: true });
  });
  return { config, parser, progress, events, files, folder, file };
}

it("does not read every target again for unchanged stdout activity", async () => {
  const { files } = await setup();
  const drain = vi.spyOn(files, "drain");
  for (let i = 0; i < 10; i++) files.sync();
  expect(drain).toHaveBeenCalledTimes(1);
});

it("continues through the rest of a file chunk if a listener throws", async () => {
  let thrown = false;
  const { files, events, folder, file } = await setup((event) => {
    if (event.type === "message.completed" && !thrown) {
      thrown = true;
      throw new Error("listener failed");
    }
  });
  await mkdir(folder, { recursive: true });
  await writeFile(file, line(assistant("one", "First")) + line(assistant("two", "Second")));
  await files.drain();
  expect(events).toContainEqual(expect.objectContaining({ type: "message.completed", text: "Second" }));
});

it("discovers late account-specific files and streams complete UTF-8 lines once, retaining distinct blocks with a shared message id", async () => {
  const { events, files, folder, file } = await setup();
  files.sync();
  await files.drain();
  await mkdir(folder, { recursive: true });
  const first = Buffer.from(line(assistant("one", "Inspecting → queue")));
  const split = first.indexOf(Buffer.from("→")) + 1;
  await writeFile(file, first.subarray(0, split));
  await files.drain();
  expect(events).toEqual([]);
  await appendFile(file, first.subarray(split));
  await expect.poll(() => events.filter((event) => event.type === "message.completed").length).toBe(1);
  await appendFile(file, line(assistant("one", "Duplicate")) + line(assistant("two", "Another block")));
  await files.drain();
  expect(events.filter((event) => event.type === "message.completed")).toMatchObject([
    { messageId: "subagent:workflow:1:one", subagentId: "workflow:1", text: "Inspecting → queue" },
    { messageId: "subagent:workflow:1:two", subagentId: "workflow:1", text: "Another block" },
  ]);
});

it("drains real prompt, thinking, tools and final text at completion and closes all callbacks on exit", async () => {
  const { progress, events, files, folder, file } = await setup();
  await mkdir(folder, { recursive: true });
  await writeFile(file, fixture.transcript.slice(0, -1).map(line).join(""));
  files.sync();
  await files.drain();
  progress("done");
  await appendFile(file, line(fixture.transcript.at(-1)));
  await files.close();
  expect(events).toContainEqual(expect.objectContaining({ type: "subagent.updated", result: "The complete result: the queue waits one frame before reading." }));
  expect(events.filter((event) => event.type === "message.completed" && event.role === "user")).toEqual([]);
  const length = events.length;
  await appendFile(file, line(assistant("too-late", "After exit")));
  files.sync();
  await files.drain();
  expect(events).toHaveLength(length);
});

it("deduplicates replay after file replacement or truncation", async () => {
  const { events, files, folder, file } = await setup();
  await mkdir(folder, { recursive: true });
  await writeFile(file, line(assistant("one", "First long record")));
  await files.drain();
  await rename(file, `${file}.old`);
  await writeFile(file, line(assistant("one", "First long record")) + line(assistant("two", "Second")));
  await files.drain();
  await writeFile(file, line(assistant("three", "Third")));
  await files.drain();
  expect(events.filter((event) => event.type === "message.completed").map((event) => event.text)).toEqual(["First long record", "Second", "Third"]);
});

it.each(["done", "error"])("drains trailing lines on %s and retires the file while the session stays open", async (state) => {
  const { progress, events, files, folder, file } = await setup();
  await mkdir(folder, { recursive: true });
  await writeFile(file, line(assistant("one", "Working")));
  files.sync();
  await files.drain();
  progress(state);
  files.sync();
  await appendFile(file, line(assistant("two", "Trailing result")));
  await expect.poll(() => events.filter((event) => event.type === "message.completed").length).toBe(2);
  await new Promise((resolve) => setTimeout(resolve, 80));
  await appendFile(file, line(assistant("late", "No longer watched")));
  await files.drain();
  expect(events.filter((event) => event.type === "message.completed")).toHaveLength(2);
});

it("reads a nested native agent's full transcript when stdout only carries task progress and the result", async () => {
  const { parser, events, files, folder } = await setup();
  parser.parseLine(
    line({
      type: "assistant",
      parent_tool_use_id: "parent-agent",
      message: { content: [{ type: "tool_use", id: "nested", name: "Agent", input: { description: "Inspect example", prompt: "Inspect the example." } }] },
    }),
  );
  parser.parseLine(line({ type: "system", subtype: "task_started", task_type: "local_agent", tool_use_id: "nested", task_id: "agent-nested", spawn_depth: 2 }));
  const nativeFolder = path.dirname(path.dirname(folder));
  await mkdir(nativeFolder, { recursive: true });
  const file = path.join(nativeFolder, "agent-agent-nested.jsonl");
  await writeFile(file, nested.transcript.slice(0, -1).map(line).join(""));
  files.sync();
  await files.drain();
  expect(events).toContainEqual(expect.objectContaining({ type: "thinking.completed", subagentId: "nested" }));
  expect(events).toContainEqual(expect.objectContaining({ type: "tool.started", name: "Read", subagentId: "nested" }));
  expect(events.filter((event) => event.type === "message.completed" && event.role === "user")).toEqual([]);
  parser.parseLine(line({ type: "system", subtype: "task_notification", task_id: "agent-nested", status: "completed", summary: "Nested report." }));
  await appendFile(file, line(nested.transcript.at(-1)));
  await files.close();
  expect(events).toContainEqual(expect.objectContaining({ type: "message.completed", subagentId: "nested", role: "assistant", text: "Nested report." }));
  expect(events.filter((event) => event.type !== "raw").every((event) => event.subagentId === "nested")).toBe(true);
});
