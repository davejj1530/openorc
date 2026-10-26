import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { takeTurn } from "./pane-turns";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Work that finishes when the test says so, recording when it started. */
function held(log: string[], name: string) {
  let finish!: () => void;
  const work = () =>
    new Promise<string>((resolve) => {
      log.push(`${name} starts`);
      finish = () => {
        log.push(`${name} ends`);
        resolve(name);
      };
    });
  return { work, finish: () => finish() };
}

it("lets one act on a pane at a time: a phone's input waits for the agent's command in flight, then goes", async () => {
  const pane = {};
  const log: string[] = [];
  const agent = held(log, "agent");
  const agentTurn = takeTurn(pane, agent.work, 5_000, "agent");
  const phoneTurn = takeTurn(pane, async () => (log.push("phone"), "phone"), 2_000, "phone");
  await vi.advanceTimersByTimeAsync(1_500);
  expect(log).toEqual(["agent starts"]);
  agent.finish();
  expect(await agentTurn).toEqual({ ok: true, value: "agent" });
  expect(await phoneTurn).toEqual({ ok: true, value: "phone" });
  expect(log).toEqual(["agent starts", "agent ends", "phone"]);
});

it("refuses the phone's input once it has waited 2 s, and never runs it after", async () => {
  const pane = {};
  const log: string[] = [];
  const agent = held(log, "agent");
  void takeTurn(pane, agent.work, 5_000, "agent");
  const phoneTurn = takeTurn(pane, async () => (log.push("phone"), "phone"), 2_000, "phone");
  await vi.advanceTimersByTimeAsync(2_000);
  expect(await phoneTurn).toEqual({ ok: false, holder: "agent" });
  agent.finish();
  await vi.advanceTimersByTimeAsync(10);
  expect(log).toEqual(["agent starts", "agent ends"]);
});

it("makes an agent's command wait out a phone's input in flight", async () => {
  const pane = {};
  const log: string[] = [];
  const phone = held(log, "phone");
  void takeTurn(pane, phone.work, 2_000, "phone");
  const agentTurn = takeTurn(pane, async () => (log.push("agent"), "agent"), 5_000, "agent");
  await vi.advanceTimersByTimeAsync(100);
  expect(log).toEqual(["phone starts"]);
  phone.finish();
  expect(await agentTurn).toEqual({ ok: true, value: "agent" });
  expect(log).toEqual(["phone starts", "phone ends", "agent"]);
});

it("lets only one of several waiters in when a turn ends, in the order they came", async () => {
  const pane = {};
  const log: string[] = [];
  const first = held(log, "first");
  void takeTurn(pane, first.work, 5_000, "agent");
  const second = held(log, "second");
  const third = held(log, "third");
  const turns = [takeTurn(pane, second.work, 5_000, "phone"), takeTurn(pane, third.work, 5_000, "agent")];
  first.finish();
  await vi.advanceTimersByTimeAsync(10);
  expect(log).toEqual(["first starts", "first ends", "second starts"]);
  second.finish();
  await vi.advanceTimersByTimeAsync(10);
  third.finish();
  expect(await Promise.all(turns)).toEqual([
    { ok: true, value: "second" },
    { ok: true, value: "third" },
  ]);
});

it("gives the turn back when the work fails, and passes the failure on", async () => {
  const pane = {};
  await expect(
    takeTurn(
      pane,
      async () => {
        throw new Error("The preview was closed.");
      },
      2_000,
      "phone",
    ),
  ).rejects.toThrow("The preview was closed.");
  expect(await takeTurn(pane, async () => "next", 2_000, "agent")).toEqual({ ok: true, value: "next" });
});

it("keeps panes apart: another pane's command does not hold this one", async () => {
  const log: string[] = [];
  const agent = held(log, "agent");
  void takeTurn({}, agent.work, 5_000, "agent");
  expect(await takeTurn({}, async () => "phone", 2_000, "phone")).toEqual({ ok: true, value: "phone" });
});

it("says who held the pane when a wait runs out: a phone's input still landing is not the agent", async () => {
  const pane = {};
  const log: string[] = [];
  const phone = held(log, "phone");
  void takeTurn(pane, phone.work, 2_000, "phone");
  const next = takeTurn(pane, async () => "next", 2_000, "phone");
  await vi.advanceTimersByTimeAsync(2_000);
  expect(await next).toEqual({ ok: false, holder: "phone" });
});
