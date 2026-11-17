// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { flatStyle, nativeProps } from "../test-fixtures/react-native";
import { FIXED_HEIGHT, type Row } from "./rows";
import { TurnHead } from "./TurnHead";

afterEach(cleanup);

const head = (row: Partial<Extract<Row, { kind: "head" }>>): Extract<Row, { kind: "head" }> => ({ kind: "head", key: "head:t", gap: 24, voice: null, sender: undefined, ...row });

it("names the agent and its model, at the height the list places it", () => {
  const view = render(<TurnHead row={head({ voice: { agent: "codex", model: "GPT-5.5" } })} />);
  expect(screen.getByText("Codex")).toBeTruthy();
  expect(screen.getByText("GPT-5.5")).toBeTruthy();
  expect(flatStyle(nativeProps.get(view.container.firstElementChild!)!.style).height).toBe(FIXED_HEIGHT.head);
});

it("names who sent a turn by first name alone where the agent did not change, and a former member as one", () => {
  const view = render(<TurnHead row={head({ sender: { id: "u-mara", name: "Mara Okafor", image: null } })} />);
  expect(screen.getByText("Mara")).toBeTruthy();
  expect(screen.queryByText("Assistant")).toBeNull();
  view.rerender(<TurnHead row={head({ sender: null })} />);
  expect(screen.getByText("Former member")).toBeTruthy();
});
