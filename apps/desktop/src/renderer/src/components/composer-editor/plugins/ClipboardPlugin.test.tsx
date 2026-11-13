import { cleanup, fireEvent } from "@testing-library/react";
import { $selectAll, getNearestEditorFromDOMNode } from "lexical";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act$, messageOf, mountEditor, type } from "../testing";

afterEach(cleanup);

const sources = { commands: [{ name: "code-review", insert: true, prefix: "/" as const }], connectors: [{ name: "paper", title: "Paper", logo: null }] };
/** A clipboard as the page hands one over, recording what is written to it. */
function clipboard(items: { text?: string; files?: File[] } = {}) {
  const written: Record<string, string> = {};
  return {
    written,
    data: {
      files: items.files ?? [],
      types: [...(items.text !== undefined ? ["text/plain"] : []), ...(items.files?.length ? ["Files"] : [])],
      getData: (kind: string) => (kind === "text/plain" ? (items.text ?? "") : ""),
      setData: (kind: string, value: string) => void (written[kind] = value),
    },
  };
}
const selectAll = (field: HTMLElement) => act(() => getNearestEditorFromDOMNode(field)!.update(() => $selectAll(), { discrete: true }));

describe("paste", () => {
  it("attaches pasted files and leaves the words alone, even with words beside them", () => {
    const onFiles = vi.fn();
    const { field } = mountEditor({ onFiles });
    type(field, "see this");
    const image = new File(["png"], "shot.png", { type: "image/png" });
    act$(field, () => fireEvent.paste(field, { clipboardData: clipboard({ text: "shot.png", files: [image] }).data }));
    expect(onFiles).toHaveBeenCalledExactlyOnceWith([image]);
    expect(messageOf(field)).toBe("see this");
  });

  it("pastes words as plain text, lines and all, with the names in them marked", () => {
    const { field } = mountEditor({ sources });
    type(field, "");
    const long = Array.from({ length: 2000 }, (_, i) => `line ${i} for @paper.`).join("\n");
    act$(field, () => fireEvent.paste(field, { clipboardData: clipboard({ text: long }).data }));
    expect(messageOf(field)).toBe(long);
    expect(field.querySelectorAll("[data-connector]")).toHaveLength(2000);
  });
});

describe("copy and cut", () => {
  it("copies the selection as its words only, marks as the words they stand for", () => {
    const { field } = mountEditor({ sources, value: "ask @paper to /code-review it" });
    selectAll(field);
    const board = clipboard();
    act$(field, () => fireEvent.copy(field, { clipboardData: board.data }));
    expect(board.written).toEqual({ "text/plain": "ask @paper to /code-review it" });
  });

  it("cuts as plain text and leaves the draft empty", () => {
    const { field } = mountEditor({ sources, value: "ask @paper" });
    selectAll(field);
    const board = clipboard();
    act$(field, () => fireEvent.cut(field, { clipboardData: board.data }));
    expect(board.written).toEqual({ "text/plain": "ask @paper" });
    expect(messageOf(field)).toBe("");
  });
});

it("puts nothing of dropped files in the words, leaving them to the composer to attach", () => {
  const { field } = mountEditor({ value: "drop here" });
  const file = new File(["x"], "notes.txt");
  expect(act$(field, () => fireEvent.drop(field, { dataTransfer: { types: ["Files"], files: [file], getData: () => "" } }))).toBe(false);
  expect(messageOf(field)).toBe("drop here");
});
