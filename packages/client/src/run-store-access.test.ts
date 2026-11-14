import { afterEach, expect, it } from "vitest";
import type { AgentEvent, RpcResults } from "@openorc/protocol";
import { testClient } from "./test-fixtures/fake-connection.js";

const { client, call } = testClient();
const { runs } = client;
const event = (runId: string, text: string): AgentEvent => ({ type: "message.completed", runId, ts: 1, messageId: text, role: "assistant", text });
afterEach(() => {
  runs.reset();
  call.mockReset();
});

it("discards a lost run immediately, ignores its delayed page and frames, and keeps local work", async () => {
  const id = "hosted:private";
  runs.applyFrame({ runId: "local", seq: 1, events: [event("local", "Local work")] });
  runs.applyFrame({ runId: id, seq: 1, events: [event(id, "Private work")] });
  runs.flush();
  let answer: (page: RpcResults["events.page"]) => void = () => {};
  call.mockReturnValueOnce(
    new Promise((resolve) => {
      answer = resolve;
    }),
  );
  const loading = runs.hydrate(id);
  const second = runs.hydrate(id);
  runs.forget([id]);
  expect(runs.snapshot().has(id)).toBe(false);
  runs.applyFrame({ runId: id, seq: 2, events: [event(id, "Late frame")] });
  answer({ events: [event(id, "Late page")], fromTurn: 0, live: true });
  await Promise.all([loading, second]);
  expect(runs.get(id)).toBeUndefined();
  expect(runs.get("local")?.blocks).toContainEqual(expect.objectContaining({ text: "Local work" }));
  call.mockResolvedValueOnce({ events: [event(id, "Granted again")], fromTurn: 0, live: false });
  await runs.hydrate(id);
  expect(runs.get(id)?.blocks).toEqual([expect.objectContaining({ text: "Granted again" })]);
});

it("an old page cannot delete a newer read after forgetting or resetting a run", async () => {
  const id = "hosted:private";
  const replies: ((page: RpcResults["events.page"]) => void)[] = [];
  call.mockImplementation(() => new Promise((resolve) => replies.push(resolve)));
  const old = runs.hydrate(id);
  runs.forget([id]);
  const next = runs.hydrate(id);
  replies[0]!({ events: [event(id, "Old")], fromTurn: 0, live: false });
  await old;
  const also = runs.hydrate(id);
  expect(call).toHaveBeenCalledTimes(2);
  replies[1]!({ events: [event(id, "New")], fromTurn: 0, live: false });
  await Promise.all([next, also]);
  expect(runs.get(id)?.blocks).toEqual([expect.objectContaining({ text: "New" })]);
  runs.reset();
  const resetting = runs.hydrate(id);
  runs.reset();
  replies[2]!({ events: [event(id, "Old account")], fromTurn: 0, live: false });
  await resetting;
  expect(runs.snapshot().size).toBe(0);
});
