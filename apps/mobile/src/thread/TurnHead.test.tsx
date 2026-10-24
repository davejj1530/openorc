// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { nativeProps } from "../test-fixtures/react-native";
import { arrive } from "../ui/motion";
import type { Row } from "./rows";
import { TurnHead } from "./TurnHead";

afterEach(cleanup);

const head = (turn: string, live: boolean): Extract<Row, { kind: "head" }> => ({
  kind: "head",
  key: `head:${turn}`,
  gap: 24,
  runId: "r",
  live,
  writing: false,
  startedAt: 1_000,
  durationMs: live ? undefined : 9_000,
  outcome: live ? undefined : "success",
});

/** Whether the head's status is rising in. */
const rising = () => Array.from(document.querySelectorAll("div")).some((element) => nativeProps.get(element)?.style === arrive);

it("swaps a head's status in as its turn finishes, but not in a view the list hands from a live turn to a finished one", () => {
  const view = render(<TurnHead row={head("live", true)} />);
  view.rerender(<TurnHead row={head("live", false)} />);
  expect(rising()).toBe(true);

  view.rerender(<TurnHead row={head("next", true)} />);
  expect(rising()).toBe(false);
  view.rerender(<TurnHead row={head("history", false)} />);
  expect(rising()).toBe(false);
});
