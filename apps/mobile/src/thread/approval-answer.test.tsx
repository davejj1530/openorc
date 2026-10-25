// @vitest-environment jsdom
import type { Block } from "@openorc/client";
import type { AgentEvent } from "@openorc/protocol";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queueAnswer } from "../notifications/answers";
import type { FakeMac } from "../test-fixtures/fake-mac";

vi.mock("expo-router", () => ({ router: { push: () => undefined } }));
const mac = vi.hoisted(() => ({ phone: null as FakeMac | null, resolved: [] as unknown[], pages: new Map<string, AgentEvent[]>(), reads: [] as string[], held: null as Promise<void> | null }));
vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac(async (method, params) => {
    if (method === "events.page") {
      const { runId } = params as { runId: string };
      mac.reads.push(runId);
      await mac.held;
      return { events: mac.pages.get(runId) ?? [], fromTurn: 0, live: true };
    }
    if (method !== "approvals.resolve") throw new Error(`no ${method}`);
    mac.resolved.push(params);
    return null;
  });
  return mac.phone.module;
});

const { client } = await import("../client");
const { ApprovalCard } = await import("./cards");

type ApprovalBlock = Extract<Block, { kind: "approval" }>;
const block = (overrides: Partial<ApprovalBlock> = {}): ApprovalBlock => ({ id: "b1", kind: "approval", approvalId: "a1", approvalKind: "command", input: { command: "ls" }, ...overrides });
const card = (props: ApprovalBlock, runId = "r1") => <ApprovalCard key={runId} block={props} runId={runId} />;
/** The fake Mac's shown id, with the run and approval an alert named. */
const answerFor = (runId = "r1", approvalId = "a1", macId = "mac-1") => ({ macId, runId, approvalId });
const requested: AgentEvent = { type: "approval.requested", eventId: "e1", runId: "r1", ts: 1, approvalId: "a1", kind: "command", input: { command: "ls" } };

beforeEach(() => {
  mac.resolved = [];
  mac.reads = [];
  mac.held = null;
  mac.pages.clear();
  client.runs.reset();
});
afterEach(cleanup);

it("sends the answer chosen on the alert, once, when its card comes on screen", async () => {
  queueAnswer(answerFor(), "deny", Date.now());
  const view = render(card(block()), { wrapper: mac.phone!.wrapper });
  await waitFor(() => expect(mac.resolved).toEqual([{ runId: "r1", approvalId: "a1", decision: "deny" }]));
  view.rerender(card(block()));
  await act(async () => undefined);
  expect(mac.resolved).toHaveLength(1);
});

it("sends an answer chosen while the card is already open", async () => {
  render(card(block()), { wrapper: mac.phone!.wrapper });
  act(() => queueAnswer(answerFor(), "allow", Date.now()));
  await waitFor(() => expect(mac.resolved).toEqual([{ runId: "r1", approvalId: "a1", decision: "allow" }]));
});

it("leaves an answer chosen as its card leaves the screen to the card that takes its place", async () => {
  const view = render(card(block()), { wrapper: mac.phone!.wrapper });
  // A tap on the alert while this thread was on screen: the thread opens again over Home as the answer is queued.
  act(() => {
    queueAnswer(answerFor(), "allow", Date.now());
    view.rerender(<></>);
  });
  view.rerender(card(block()));
  await waitFor(() => expect(mac.resolved).toEqual([{ runId: "r1", approvalId: "a1", decision: "allow" }]));
});

it("still sends an answer its card took when the card leaves the screen while it asks the Mac", async () => {
  mac.pages.set("r1", [requested]);
  const release = client.runs.retain(["r1"]);
  await client.runs.hydrate("r1");
  let answer = () => undefined as void;
  mac.held = new Promise((resolve) => (answer = resolve));

  const view = render(card(block()), { wrapper: mac.phone!.wrapper });
  act(() => queueAnswer(answerFor(), "allow", Date.now()));
  await waitFor(() => expect(mac.reads).toEqual(["r1", "r1"]));
  view.rerender(<></>);
  act(answer);
  await waitFor(() => expect(mac.resolved).toEqual([{ runId: "r1", approvalId: "a1", decision: "allow" }]));
  view.rerender(card(block()));
  await act(async () => undefined);
  expect(mac.resolved).toHaveLength(1);
  release();
});

it("never sends it once the approval was answered elsewhere", async () => {
  queueAnswer(answerFor(), "allow", Date.now());
  render(card(block({ decision: "deny" })), { wrapper: mac.phone!.wrapper });
  await act(async () => undefined);
  expect(mac.resolved).toEqual([]);
});

it("leaves an answer for another run's or another Mac's approval with the same id to that approval", async () => {
  queueAnswer(answerFor("r2"), "allow", Date.now());
  queueAnswer(answerFor("r1", "a1", "mac-2"), "allow", Date.now());
  const view = render(card(block()), { wrapper: mac.phone!.wrapper });
  await act(async () => undefined);
  expect(mac.resolved).toEqual([]);
  view.rerender(card(block(), "r2"));
  await waitFor(() => expect(mac.resolved).toEqual([{ runId: "r2", approvalId: "a1", decision: "allow" }]));
});

it("asks the Mac again before sending, and sends nothing when it was answered there while the card sat on screen", async () => {
  mac.pages.set("r1", [requested]);
  const release = client.runs.retain(["r1"]);
  await client.runs.hydrate("r1");
  mac.pages.set("r1", [requested, { type: "approval.resolved", eventId: "e2", runId: "r1", ts: 2, approvalId: "a1", decision: "allow" }]);

  queueAnswer(answerFor(), "deny", Date.now());
  render(card(block()), { wrapper: mac.phone!.wrapper });
  await waitFor(() => expect(mac.reads).toEqual(["r1", "r1"]));
  await act(async () => undefined);
  expect(mac.resolved).toEqual([]);
  release();
});
