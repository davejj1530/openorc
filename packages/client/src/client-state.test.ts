import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryObserver, type QueryClient } from "@tanstack/react-query";
import type { AgentEvent } from "@openorc/protocol";
import { testClient } from "./test-fixtures/fake-connection.js";

const started = (runId: string): AgentEvent => ({ type: "session.started", runId, ts: 1, agent: "codex", externalSessionId: runId, model: "m", eventId: `${runId}-start` });
const ended = (runId: string): AgentEvent => ({ type: "session.completed", runId, ts: 3, status: "success", durationMs: 2, eventId: `${runId}-end` });
const reply = (runId: string, text: string, eventId: string): AgentEvent => ({ type: "message.delta", runId, ts: 2, messageId: "m", role: "assistant", text, eventId });
const page = (events: AgentEvent[], fromTurn = 0) => ({ events, fromTurn, live: false });

afterEach(() => vi.useRealTimers());

describe("frame interest", () => {
  it("follows what views hold, what loads, and what is live in memory, without being kept by hand", () => {
    vi.useFakeTimers();
    const { client, push, wire } = testClient("interest");
    const release = client.runs.retain(["shown"]);
    push({ type: "frame", frame: { runId: "streaming", seq: 1, events: [started("streaming")] } });
    push({ type: "frame", frame: { runId: "streaming", seq: 2, events: [ended("streaming")] } });
    release();
    vi.advanceTimersByTime(4 * 60_000);
    expect(wire).toEqual(["interest shown", "interest shown,streaming", "interest shown", "interest "]);
  });

  it("asks for a run's frames before its page, so none fall between them", async () => {
    const { client, call, wire } = testClient("interest");
    call.mockResolvedValueOnce(page([started("run")]));
    await client.runs.hydrate("run");
    expect(wire.slice(0, 2)).toEqual(["interest run", "call events.page"]);
    expect(client.runs.get("run")?.live).toBe(true);
  });

  it("leaves a window's connection alone, since a window hears every run", async () => {
    const { client, call, wire } = testClient("all");
    call.mockResolvedValueOnce(page([started("run")]));
    client.runs.retain(["run"]);
    await client.runs.hydrate("run");
    expect(wire).toEqual(["call events.page"]);
  });
});

describe("sessions and gaps", () => {
  it("refreshes the probed machine on a first session and nothing else", async () => {
    const { client, push, call } = testClient();
    const models = observe(client.queryClient, ["agents.models", {}], ["models"]);
    const tasks = observe(client.queryClient, ["tasks.list", {}], ["tasks"]);
    await vi.waitFor(() => expect([models.reads, tasks.reads]).toEqual([1, 1]));
    push({ type: "session", resumed: false });
    await vi.waitFor(() => expect(models.reads).toBe(2));
    expect(tasks.reads).toBe(1);
    expect(call).not.toHaveBeenCalled();
    models.stop();
    tasks.stop();
  });

  it("refetches every query after a resumed session and reloads shown runs over the window they had", async () => {
    const { client, push, call } = testClient();
    call.mockResolvedValueOnce(page([reply("shown", "before", "s1")], 2));
    client.runs.retain(["shown"]);
    await client.runs.hydrate("shown", { turns: 4 });
    push({ type: "frame", frame: { runId: "unshown", seq: 1, events: [started("unshown")] } });
    const tasks = observe(client.queryClient, ["tasks.list", {}], ["tasks"]);
    await vi.waitFor(() => expect(tasks.reads).toBe(1));
    call.mockResolvedValueOnce(page([reply("shown", "after", "s2")], 2));
    push({ type: "session", resumed: true });
    await vi.waitFor(() => expect(client.runs.get("shown")?.blocks).toMatchObject([{ text: "after" }]));
    expect(call).toHaveBeenLastCalledWith("events.page", { runId: "shown", fromTurn: 2 });
    expect(client.runs.get("unshown")).toBeUndefined();
    await vi.waitFor(() => expect(tasks.reads).toBe(2));
    tasks.stop();
  });

  it("reloads only the runs whose frames were dropped", async () => {
    const { client, push, call } = testClient();
    client.runs.retain(["gapped", "fine"]);
    call.mockResolvedValueOnce(page([reply("gapped", "one", "g1")]));
    call.mockResolvedValueOnce(page([reply("fine", "one", "f1")]));
    await Promise.all([client.runs.hydrate("gapped"), client.runs.hydrate("fine")]);
    call.mockClear();
    call.mockResolvedValueOnce(page([reply("gapped", "one", "g1"), reply("gapped", " two", "g2")]));
    push({ type: "gap", runIds: ["gapped"] });
    await vi.waitFor(() => expect(client.runs.get("gapped")?.blocks).toMatchObject([{ text: "one two" }]));
    expect(call.mock.calls).toEqual([["events.page", { runId: "gapped", fromTurn: 0 }]]);
  });

  it("waits for a load in flight before reloading after a gap", async () => {
    const { client, push, call } = testClient();
    client.runs.retain(["run"]);
    let answer: (value: unknown) => void = () => undefined;
    call.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const loading = client.runs.hydrate("run");
    call.mockResolvedValueOnce(page([reply("run", "fresh", "e2")]));
    push({ type: "gap", runIds: ["run"] });
    answer(page([reply("run", "stale", "e1")]));
    await loading;
    await vi.waitFor(() => expect(client.runs.get("run")?.blocks).toMatchObject([{ text: "fresh" }]));
    expect(call).toHaveBeenCalledTimes(2);
  });
});

describe("notices", () => {
  it("reach every listener until it stops listening", () => {
    const { client, push } = testClient();
    const heard: string[] = [];
    const stop = client.onNotify((notice) => heard.push(notice.title));
    const notice = { kind: "finished" as const, threadId: "t", taskId: null, title: "Done", body: "" };
    push({ type: "notify", notice });
    stop();
    push({ type: "notify", notice });
    expect(heard).toEqual(["Done"]);
  });
});

describe("delivered twice", () => {
  it("still drops a repeated recent event after remembering thousands", () => {
    const { client, push } = testClient();
    const events = Array.from({ length: 5000 }, (_, i) => reply("long", "x", `e${i}`));
    push({ type: "frame", frame: { runId: "long", seq: 1, events } });
    push({ type: "frame", frame: { runId: "long", seq: 2, events: events.slice(-100) } });
    const run = client.runs.get("long")!;
    expect(run.blocks).toMatchObject([{ text: "x".repeat(5000) }]);
    expect(run.eventIds!.size).toBeLessThanOrEqual(4096);
  });
});

/** A mounted query counting its reads; `reads` counts reads that finished, so a refresh is never mistaken for one in flight. */
function observe(queryClient: QueryClient, queryKey: unknown[], tags: string[]) {
  let started = 0;
  const observer = new QueryObserver(queryClient, { queryKey, meta: { tags }, queryFn: async () => ++started });
  const stop = observer.subscribe(() => {});
  return {
    get reads() {
      return observer.getCurrentResult().data ?? 0;
    },
    stop,
  };
}
