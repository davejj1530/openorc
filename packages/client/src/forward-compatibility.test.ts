import { expect, it, vi } from "vitest";
import type { AgentEvent } from "@openorc/protocol";
import type { ClientPush } from "./connection.js";
import { applyEvents, emptyRun } from "./transcript.js";
import { testClient } from "./test-fixtures/fake-connection.js";

it("ignores future event types and inherited handler names without ending ongoing thinking", () => {
  const run = emptyRun("run");
  applyEvents(run, [{ type: "thinking.delta", runId: "run", ts: 1, messageId: "thinking", text: "Working" }]);
  const before = JSON.stringify(run);
  for (const type of ["future.event", "constructor", "__proto__"]) {
    expect(() => applyEvents(run, [{ type, runId: "run", ts: 2 } as unknown as AgentEvent])).not.toThrow();
  }
  expect(JSON.stringify(run)).toEqual(before);
  applyEvents(run, [{ type: "message.completed", runId: "run", ts: 3, messageId: "answer", role: "assistant", text: "Done" }]);
  expect(run.blocks.at(-1)).toMatchObject({ kind: "message", text: "Done" });
});

it("ignores future push types without calling inherited object methods", () => {
  const { push, client } = testClient();
  for (const type of ["future.push", "constructor", "__proto__"]) expect(() => push({ type } as unknown as ClientPush)).not.toThrow();
  expect(client.runs.get("run")).toBeUndefined();
});

it("drops a failed frame without publishing its partial changes and continues with the next frame", () => {
  const log = vi.fn();
  const { client } = testClient("all", { reportFrameError: log });
  const message = (id: string, text: string): AgentEvent => ({ type: "message.completed", runId: "run", ts: 1, messageId: id, role: "assistant", text, eventId: id });
  client.runs.applyFrame({ runId: "run", seq: 1, events: [message("kept", "Before")] });
  client.runs.flush();
  const before = client.runs.get("run");
  try {
    expect(() => client.runs.applyFrame({ runId: "run", seq: 2, events: [message("answer", "Partial"), null as unknown as AgentEvent] })).not.toThrow();
    client.runs.flush();
    expect(client.runs.get("run")).toBe(before);
    expect(log).toHaveBeenCalledOnce();
    client.runs.applyFrame({ runId: "run", seq: 3, events: [message("answer", "After")] });
    client.runs.flush();
    expect(client.runs.get("run")?.blocks.map((block) => block.kind === "message" && block.text)).toEqual(["Before", "After"]);
  } finally {
    client.runs.reset();
  }
});

it("ignores future history events and drops a broken buffered frame without losing later buffered work", async () => {
  const log = vi.fn();
  const { client, call } = testClient("interest", { reportFrameError: log });
  let loaded!: (value: unknown) => void;
  call.mockReturnValueOnce(
    new Promise((resolve) => {
      loaded = resolve;
    }),
  );
  const message = (id: string): AgentEvent => ({ type: "message.completed", runId: "run", ts: 1, messageId: id, role: "assistant", text: id, eventId: id });
  try {
    const hydration = client.runs.hydrate("run");
    client.runs.applyFrame({ runId: "run", seq: 1, events: [message("partial"), null as unknown as AgentEvent] });
    client.runs.applyFrame({ runId: "run", seq: 2, events: [message("later")] });
    loaded({ events: [message("history"), { type: "future.event", runId: "run", ts: 2 }], fromTurn: 0, live: false });
    await hydration;
    expect(client.runs.get("run")?.blocks.map((block) => block.kind === "message" && block.text)).toEqual(["history", "later"]);
    expect(log).toHaveBeenCalledOnce();
  } finally {
    client.runs.reset();
  }
});
