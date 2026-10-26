// @vitest-environment jsdom
import type { PreviewFocus, PreviewInput } from "@openorc/protocol";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { nativeProps } from "../test-fixtures/react-native";
import { PreviewKeys } from "./PreviewKeys";

vi.mock("react-native-keyboard-controller", () => ({ KeyboardStickyView: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

afterEach(cleanup);

type Text = Extract<PreviewFocus, { kind: "text" }>;
const field: Text = { kind: "text", keyboard: "default", enter: "default", secure: false, multiline: false };

function keys(focus: Text | null = field, number = 1) {
  const sent: PreviewInput[] = [];
  const end = vi.fn();
  const draw = (next: Text | null, at: number) => <PreviewKeys focus={next} field={at} label="QA Fields" onInputs={(inputs) => sent.push(...inputs)} onEnd={end} />;
  const view = render(draw(focus, number));
  const input = () => document.querySelector("input")!;
  const props = () => nativeProps.get(input())!;
  const change = (text: string) => act(() => (props().onChangeText as (text: string) => void)(text));
  return { sent, end, input, props, change, redraw: (next: Text | null, at = number) => view.rerender(draw(next, at)) };
}

it("takes the keyboard the Mac's field asks for: its keys, its return key, secure entry for a password", () => {
  const view = keys({ ...field, keyboard: "email", enter: "go" });
  expect(view.props()).toMatchObject({ keyboardType: "email-address", returnKeyType: "go", autoCapitalize: "none", autoCorrect: false, secureTextEntry: false, multiline: false });
  view.redraw({ ...field, secure: true });
  expect(view.props()).toMatchObject({ secureTextEntry: true, autoCorrect: false });
  view.redraw({ ...field, keyboard: "numeric", multiline: true });
  expect(view.props()).toMatchObject({ keyboardType: "numbers-and-punctuation", multiline: true });
  view.redraw(field);
  expect(view.props()).toMatchObject({ keyboardType: "default", autoCapitalize: "sentences", autoCorrect: true, accessibilityLabel: "QA Fields" });
});

it("streams what is typed as edits, so autocorrect's replacements land as they do on the phone", () => {
  const view = keys();
  view.change("teh");
  view.change("teh ");
  view.change("the ");
  expect(view.sent).toEqual([
    { kind: "text", text: "teh" },
    { kind: "text", text: " " },
    { kind: "key", key: "Backspace", count: 3 },
    { kind: "text", text: "he " },
  ]);
});

it("sends Backspace from an empty field, which deletes on the Mac, and Return as Enter", () => {
  const view = keys();
  act(() => (view.props().onKeyPress as (event: object) => void)({ nativeEvent: { key: "Backspace" } }));
  view.change("a");
  act(() => (view.props().onKeyPress as (event: object) => void)({ nativeEvent: { key: "Backspace" } }));
  act(() => (view.props().onSubmitEditing as () => void)());
  expect(view.sent).toEqual([
    { kind: "key", key: "Backspace", count: 1 },
    { kind: "text", text: "a" },
    { kind: "key", key: "Enter", count: 1 },
  ]);
  expect(view.props().submitBehavior).toBe("submit");
});

it("starts empty for each new field, and its bar sends Tab and puts the keyboard away", () => {
  const view = keys();
  view.change("abc");
  view.redraw(field, 2);
  expect(view.props().value).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Tab" }));
  expect(view.sent.at(-1)).toEqual({ kind: "key", key: "Tab", count: 1 });
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(view.end).toHaveBeenCalled();
});

it("ends typing when the keyboard goes away, and keeps its field mounted without one, so nothing blurs a field that is gone", () => {
  const view = keys();
  act(() => (view.props().onBlur as () => void)());
  expect(view.end).toHaveBeenCalledTimes(1);
  view.redraw(null);
  expect(screen.queryByRole("button", { name: "Tab" })).toBeNull();
  expect(view.input()).toBeTruthy();
  expect(view.props().accessibilityElementsHidden).toBe(true);
  // The keyboard going away because the Mac's focus left the field is not the person ending it.
  act(() => (view.props().onBlur as () => void)());
  expect(view.end).toHaveBeenCalledTimes(1);
});
