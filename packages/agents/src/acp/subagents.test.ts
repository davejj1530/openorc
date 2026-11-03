import { expect, it } from "vitest";
import type { AgentEvent } from "@openorc/protocol";
import { AcpSubagents } from "./subagents.js";
function setup() {
  const events: AgentEvent[] = [];
  const children = new AcpSubagents(
    "run",
    () => "root",
    (e) => events.push(e),
  );
  const legacy = () =>
    children.legacy({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Answer" }, _meta: { "opencode/child-session": { id: "child", parentID: "root", title: "Inspect" } } }, 1);
  const launch = () => children.observe("root", { sessionUpdate: "tool_call", toolCallId: "launch", title: "subagent", rawInput: { agent: "explore", description: "Inspect", prompt: "Read" } }, 0);
  const result = (status: string, native: string, error?: string) =>
    children.observe(
      "root",
      { sessionUpdate: "tool_call_update", toolCallId: "launch", status: status === "failed" ? "failed" : "completed", rawOutput: { metadata: { sessionID: "child", status: native }, error } },
      3,
    );
  const state = (status: string, error?: string) => children.route({ rootSessionId: "root", childSessionId: "child", parentSessionId: "root", title: "Inspect", type: "status", status, error }, 2);
  return { events, children, legacy, launch, result, state };
}
it.each(["completed", "cancelled", "failed"] as const)("settles legacy children from the parent tool result: %s", (status) => {
  const s = setup();
  s.launch();
  s.legacy();
  s.result(status === "completed" ? "completed" : "failed", status === "completed" ? "completed" : "running", status === "cancelled" ? "Subagent cancelled" : "Boom");
  expect(s.children.canStop("child")).toBe(false);
  expect(s.events.at(-1)).toMatchObject({ type: "subagent.updated", status: status === "cancelled" ? "stopped" : status });
  if (status === "failed") expect(s.events.at(-1)).toMatchObject({ error: "Boom" });
  expect(s.events).toContainEqual(expect.objectContaining({ type: "message.completed", text: "Answer" }));
});
it("closes a legacy background transcript when its stream ends without pretending the unseen work completed", () => {
  const s = setup();
  s.launch();
  s.legacy();
  s.result("completed", "running");
  s.children.endParentTurn(4);
  expect(s.events.at(-1)).toMatchObject({ type: "subagent.updated", status: "no_updates" });
});
it("settles a legacy cancellation without waiting for absent status notifications", () => {
  const s = setup();
  s.legacy();
  s.children.cancelled("child", 2);
  s.result("failed", "running", "Subagent cancelled");
  expect(s.events.at(-1)).toMatchObject({ status: "stopped" });
});
it("preserves native terminal status and error across stale parent tool results, and drains on exit", () => {
  const s = setup();
  s.launch();
  s.state("created");
  s.state("interrupted");
  s.result("failed", "running", "Subagent cancelled");
  expect(s.events.at(-1)).toMatchObject({ status: "stopped" });
  s.state("running");
  s.state("failed", "Provider failed");
  expect(s.events.at(-1)).toMatchObject({ status: "failed", error: "Provider failed" });
  s.state("running");
  s.children.endParentTurn(4);
  expect(s.children.canStop("child")).toBe(true);
  s.children.close(5);
  expect(s.children.canStop("child")).toBe(false);
  expect(s.events.at(-1)).toMatchObject({ status: "stopped" });
});
it("drops a child whose parent session was never announced", () => {
  const s = setup();
  s.children.route({ rootSessionId: "root", childSessionId: "orphan", parentSessionId: "missing", title: "Orphan", type: "status", status: "created" }, 1);
  expect(s.events).toEqual([]);
  expect(s.children.legacy({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hidden" }, _meta: { "opencode/child-session": { id: "orphan", parentID: "missing" } } }, 2)).toBe(
    true,
  );
  expect(s.events).toEqual([]);
});

it.each(["completed", "failed"])("ignores a stale %s parent result after a resumed child's native status", (status) => {
  const s = setup();
  s.launch();
  s.state("completed");
  s.state("running");
  s.result(status, status, "Old result");
  expect(s.children.canStop("child")).toBe(true);
  expect(s.events.filter((e) => e.type === "subagent.updated").at(-1)).toMatchObject({ status: "running" });
});
it("keeps a user cancellation Stopped even when the legacy parent ends before its acknowledgement", () => {
  const s = setup();
  s.legacy();
  s.children.endParentTurn(3);
  s.children.cancelled("child", 4);
  s.children.endParentTurn(5);
  expect(s.events.at(-1)).toMatchObject({ status: "stopped" });
  expect(s.events.some((e) => e.type === "subagent.updated" && e.error)).toBe(false);
});
