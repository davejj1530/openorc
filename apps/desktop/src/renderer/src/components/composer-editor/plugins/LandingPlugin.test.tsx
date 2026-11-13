import { act, cleanup } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, expect, it } from "vitest";
import type { MarkSources } from "../../../lib/message-marks";
import type { ComposerEditorHandle } from "../ComposerEditor";
import { mountEditor, press, type } from "../testing";

afterEach(cleanup);

const sources: MarkSources = { connectors: [{ name: "paper", title: "Paper", logo: null }] };
const landing = (field: HTMLElement) => [...field.querySelectorAll("[data-landing] .mark-pill-name")].map((element) => element.textContent);

it("pops a pill picked from a list, and only that one", () => {
  const handle = createRef<ComposerEditorHandle>();
  const { field } = mountEditor({ sources, handle });
  act(() => handle.current!.write("ask @paper ", 11));
  expect(landing(field)).toEqual(["Paper"]);
});

it("keeps still a pill that arrives by typing, an undo or a draft coming back", () => {
  const handle = createRef<ComposerEditorHandle>();
  const typed = mountEditor({ sources, handle });
  type(typed.field, "ask @paper now");
  expect(typed.field.querySelector("[data-connector]")).not.toBeNull();
  expect(landing(typed.field)).toEqual([]);
  act(() => handle.current!.write("ask  now", 4));
  press(typed.field, { key: "z", ctrlKey: true });
  expect(typed.field.querySelector("[data-connector]")).not.toBeNull();
  expect(landing(typed.field)).toEqual([]);
  cleanup();
  const restored = mountEditor({ sources, value: "ask @paper now" });
  expect(restored.field.querySelector("[data-connector]")).not.toBeNull();
  expect(landing(restored.field)).toEqual([]);
});
