import { expect, it } from "vitest";
import type { Block } from "./transcript.js";
import { taskReferenceFromTool } from "./task-tool-reference.js";
import { taskIdFromTool, uniqueTaskCards } from "./task-progress.js";

const id = "41c0591f-e6ae-4f8b-b3ac-a6b55b99cc32";
const taskRef = { place: "server", spaceId: "org:fixture", projectId: "project-one", id };
const block = (output: unknown): Extract<Block, { kind: "tool" }> => ({ id: "task-call", kind: "tool", name: "mcp__openorc__task_create", input: {}, done: true, output });

it.each(["text", "content", "object", "nested"])("carries a server reference from %s output while keeping the legacy id", (format) => {
  const result = format === "nested" ? { task: { id, taskRef } } : { id, taskRef };
  let output: unknown = JSON.stringify(result);
  if (format === "object") output = result;
  if (format === "content") output = { content: [{ type: "text", text: JSON.stringify(result) }] };
  const tool = block(output);
  expect(taskIdFromTool(tool)).toBe(id);
  expect(taskReferenceFromTool(tool, id)).toEqual({ kind: "online", reference: taskRef });
});
it("keeps omitted scope local and never treats a malformed server reference as local", () => {
  expect(taskReferenceFromTool(block(JSON.stringify({ id })), id)).toEqual({ kind: "none" });
  for (const ref of [null, { ...taskRef, id: "different" }, { ...taskRef, place: "mac" }, { ...taskRef, projectId: "" }]) {
    expect(taskReferenceFromTool(block(JSON.stringify({ id, taskRef: ref })), id)).toEqual({ kind: "unavailable" });
  }
  expect(taskReferenceFromTool(block(`{"id":"${id}","taskRef":`), id)).toEqual({ kind: "unavailable" });
});
it("deduplicates within one task authority while retaining a same-id Mac and other-project task", () => {
  const local = block(JSON.stringify({ id }));
  const server = block(JSON.stringify({ id, taskRef }));
  const other = block(JSON.stringify({ id, taskRef: { ...taskRef, projectId: "project-two" } }));
  expect(uniqueTaskCards([local, server, { ...server, id: "repeat" }, other], true)).toEqual([local, server, other]);
});
