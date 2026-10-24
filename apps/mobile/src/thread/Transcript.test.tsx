// @vitest-environment jsdom
import type { LegendListRef } from "@legendapp/list/react-native";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Fragment, type ReactElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nativeProps, placed, screen as phone } from "../test-fixtures/react-native";
import type { Row } from "./rows";
import { activity, finishedTurn, type runStore } from "./test-fixtures/run-store";
import { Transcript } from "./Transcript";

const transcript = vi.hoisted(() => ({ store: null as ReturnType<typeof runStore> | null, rows: [] as Row[] }));

// The list draws every row it is handed, in order.
vi.mock("@legendapp/list/keyboard", () => ({
  KeyboardAwareLegendList: ({ data, renderItem }: { data: Row[]; renderItem: (info: { item: Row }) => ReactElement }) => {
    transcript.rows = data;
    return data.map((item) => <Fragment key={item.key}>{renderItem({ item })}</Fragment>);
  },
}));
vi.mock("react-native-keyboard-controller", () => ({ useReanimatedKeyboardAnimation: () => ({ height: { value: 0 } }) }));
vi.mock("expo-router", () => ({ router: { push: () => undefined } }));
vi.mock("./Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }));
vi.mock("../client", async () => {
  const { runStore } = await import("./test-fixtures/run-store");
  transcript.store = runStore();
  return { client: transcript.store.client };
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  transcript.store!.client.runs.reset();
  placed.y = () => 0;
  placed.height = () => 0;
});

it("scrolls a focused answer field to the foot of what stays in view once the keyboard is up, however far up its card it sits", () => {
  const { client, frame } = transcript.store!;
  frame(...finishedTurn);
  const run = frame(
    { type: "turn.started", turnId: "t2" },
    { type: "message.completed", messageId: "ask-2", role: "user", text: "Set up the tests" },
    { type: "approval.requested", approvalId: "q", kind: "user_input", input: { questions: [{ id: "runner", question: "Which runner?" }] } },
  );
  const scrollToIndex = vi.fn();
  const listRef = { current: { scrollToIndex, scrollToEnd: () => undefined, getState: () => ({ contentLength: 0, scrollLength: 1 }) } as unknown as LegendListRef };
  render(
    <QueryClientProvider client={client.queryClient}>
      <Transcript
        blocks={run.blocks}
        {...activity(run)}
        runId="r"
        hasOlder={false}
        loadOlder={() => undefined}
        filled
        composerInset={{ value: 0 } as never}
        listRef={listRef}
        onFollow={() => undefined}
        following
        followKey={0}
      />
    </QueryClientProvider>,
  );
  const field = screen.getByLabelText("Which runner?");
  // The card is as tall as the screen; the field's top sits 600 pt down it, and the field is 44 pt tall.
  placed.y = (view) => (view === field ? 600 : 0);
  placed.height = (view) => (view === field ? 44 : 0);
  const focus = nativeProps.get(field)!.onFocus as (event: { currentTarget: Element }) => void;
  act(() => focus({ currentTarget: field }));
  expect(scrollToIndex).not.toHaveBeenCalled();
  act(() => void vi.advanceTimersByTime(250));
  const card = transcript.rows.findIndex((row) => row.kind === "card");
  expect(card).toBeGreaterThan(0);
  expect(scrollToIndex).toHaveBeenCalledWith({ index: card, viewPosition: 1, viewOffset: phone.height - 600 - 44 - 12, animated: true });
});
