// @vitest-environment jsdom
import type { Block } from "@openorc/client";
import type { RpcMethod, ThreadCollaboration } from "@openorc/protocol";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadQueue } from "../composer/ThreadQueue";
import { useComposer, type ComposerInput } from "../composer/use-composer";
import { fixtureThreads } from "../home/test-fixtures/threads";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { ApprovalCard } from "./cards";
import { TogetherContext, turnSeen } from "./cloud-together";

/** A Mac that answers every call with nothing, and keeps what the phone sent. */
const mac = vi.hoisted(() => ({ phone: null as FakeMac | null, calls: [] as { method: string; params: unknown }[] }));
vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac((method: RpcMethod, params) => {
    mac.calls.push({ method, params });
    return Promise.resolve(null);
  });
  return mac.phone.module;
});
vi.mock("../composer/use-image-attach", () => ({ useImageAttach: () => ({ uploading: 0, chooseImages: () => undefined }) }));
vi.mock("expo-haptics", () => ({ notificationAsync: () => undefined, impactAsync: () => undefined, selectionAsync: () => undefined, NotificationFeedbackType: {}, ImpactFeedbackStyle: {} }));
vi.mock("expo-router", () => ({ router: { push: () => undefined } }));
vi.mock("./Markdown", () => ({ Markdown: ({ text }: { text: string }) => createElement("div", null, text) }));
vi.mock("../notifications/answers", () => ({ useQueuedAnswer: () => null, takeQueued: () => null }));

afterEach(() => {
  cleanup();
  mac.calls.length = 0;
});

const mara = { id: "u-mara", name: "Mara Okafor", image: null };
const together = (facts: Partial<ThreadCollaboration>): ThreadCollaboration => ({
  viewer: { id: "u-riley", name: "Riley Chen", image: null },
  canWrite: true,
  live: { id: "turn-7", sender: mara, startedAt: 1, stopping: false },
  send: "now",
  handoff: null,
  canPostNote: true,
  canStop: true,
  ask: null,
  queue: [],
  mentions: { unread: false, firstUnreadNoteId: null },
  noteHead: 0,
  ...facts,
});
const runId = "hosted:t1";
const input = (state: ThreadCollaboration): ComposerInput => ({
  threadId: "t1",
  request: {
    target: { kind: "thread", threadId: "t1" },
    working: true,
    live: true,
    activeRun: undefined,
    agentsUsed: [],
    choice: null,
    mode: "act",
    permission: "trusted",
    permissionReady: true,
    compacting: false,
    waitForSave: () => Promise.resolve(),
  },
  live: { runId },
  working: true,
  canSteer: true,
  disabledReason: null,
  onSent: () => undefined,
  turnSeen: turnSeen(state),
  attachRefusal: "Files can't be sent to a cloud thread from a phone yet.",
});

it("stops the turn it saw running in a cloud thread, by its id", async () => {
  const composer = renderHook(() => useComposer(input(together({}))), { wrapper: mac.phone!.wrapper });
  await act(async () => composer.result.current.stop());
  expect(mac.calls).toEqual([{ method: "runs.interrupt", params: { runId, expectedTurnId: "turn-7" } }]);
});

it("sends into the running turn it saw by naming it, through the same send as on the Mac", async () => {
  const steering = input(together({}));
  const request = {
    ...steering.request,
    activeRun: { id: runId, agent: "claude" as const, mode: "act" as const, permissionMode: "trusted" as const },
    choice: { agent: "claude" as const, model: "claude-opus", effort: null },
    ...turnSeen(together({})),
  };
  const composer = renderHook(() => useComposer({ ...steering, request }), { wrapper: mac.phone!.wrapper });
  act(() => composer.result.current.setText("Keep the annual toggle on top."));
  await act(async () => composer.result.current.primary());
  expect(mac.calls.filter((call) => call.method === "runs.send")).toEqual([
    { method: "runs.send", params: expect.objectContaining({ runId, text: "Keep the annual toggle on top.", expectedTurnId: "turn-7" }) },
  ]);
});

it("says why it cannot attach in a cloud thread instead of opening the photos", () => {
  const composer = renderHook(() => useComposer(input(together({}))), { wrapper: mac.phone!.wrapper });
  expect(composer.result.current.attachDimmed).toBe(true);
  act(() => composer.result.current.chooseImages());
  expect(composer.result.current.error).toBe("Files can't be sent to a cloud thread from a phone yet.");
});

const approval: Extract<Block, { kind: "approval" }> = { id: "approval-ask-1", kind: "approval", approvalId: "ask-1", approvalKind: "command", toolName: "Bash", input: { command: "pnpm build" } };
const withTogether =
  (state: ThreadCollaboration | null) =>
  ({ children }: { children: ReactNode }) =>
    createElement(mac.phone!.wrapper, null, createElement(TogetherContext.Provider, { value: state }, children));
const ask = (facts: Partial<NonNullable<ThreadCollaboration["ask"]>>) => ({
  id: "ask-1",
  turnId: "turn-7",
  state: "waiting" as const,
  sender: mara,
  answer: "live" as const,
  canDecline: true,
  reason: null,
  ...facts,
});

it("answers the ask in the phase it saw it, and says when answering starts the reader's own turn", async () => {
  render(createElement(ApprovalCard, { block: approval, runId }), { wrapper: withTogether(together({ live: null, ask: ask({ state: "parked", answer: "start", turnId: "turn-6" }) })) });
  expect(screen.getByText("Answering starts your own turn, on your sign-in and hours.")).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByText("Allow")));
  expect(mac.calls).toEqual([{ method: "approvals.resolve", params: { runId, approvalId: "ask-1", decision: "allow", expectedState: "parked", expectedTurnId: "turn-6" } }]);
});

it("keeps an ask someone else must answer from being answered here, in the server's words", async () => {
  render(createElement(ApprovalCard, { block: approval, runId }), {
    wrapper: withTogether(together({ ask: ask({ answer: "blocked", canDecline: false, reason: "Mara can answer while this turn is running." }) })),
  });
  expect(screen.getByText("Mara can answer while this turn is running.")).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByText("Allow"));
    fireEvent.click(screen.getByText("Deny"));
  });
  expect(mac.calls).toEqual([]);
});

it("answers on this Mac as always, with nothing named", async () => {
  render(createElement(ApprovalCard, { block: approval, runId: "mac-run" }), { wrapper: withTogether(null) });
  await act(async () => fireEvent.click(screen.getByText("Allow")));
  expect(mac.calls).toEqual([{ method: "approvals.resolve", params: { runId: "mac-run", approvalId: "ask-1", decision: "allow" } }]);
});

it("sends a waiting message now into the running turn it saw, in a cloud thread as on the Mac", async () => {
  const thread = { ...fixtureThreads[0]!, id: "t1", owner: { brain: "hosted" as const, reach: "live" as const, heardAt: 1 } };
  const queued = [{ id: "q1", text: "And the footer too", attachments: [], queuedAt: 1 }];
  render(
    <TogetherContext.Provider value={together({})}>
      <ThreadQueue thread={thread} queued={queued} canSteer typing={false} onSent={() => undefined} />
    </TogetherContext.Provider>,
    { wrapper: mac.phone!.wrapper },
  );
  fireEvent.click(screen.getByRole("button", { name: /^1 queued/ }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send now" })));
  expect(mac.calls).toContainEqual({ method: "threads.sendQueued", params: { id: "t1", messageId: "q1", expectedTurnId: "turn-7" } });
});
