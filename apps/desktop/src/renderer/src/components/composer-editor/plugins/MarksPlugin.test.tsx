import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { createRef, useState } from "react";
import { afterEach, expect, it } from "vitest";
import type { MarkSources } from "../../../lib/message-marks";
import { ComposerEditor, type ComposerEditorHandle } from "../ComposerEditor";
import { act$, messageOf, mountEditor, press, type } from "../testing";

afterEach(cleanup);

const skills: MarkSources = { commands: [{ name: "code-review", insert: true, prefix: "/" }] };
const marks = (field: HTMLElement) => [...field.querySelectorAll("mark, [data-member], [data-file]")].map((mark) => mark.textContent);

it("marks the words already written when the list naming them arrives, as no step to undo", () => {
  const setSources: { current: (sources: MarkSources) => void } = { current: () => {} };
  function Owner() {
    const [sources, set] = useState<MarkSources>({});
    const [value, setValue] = useState("please /code-review it");
    setSources.current = set;
    return (
      <ComposerEditor
        value={value}
        onChange={(change) => change.edited && setValue(change.text)}
        sources={sources}
        onKeyDown={() => false}
        onFiles={() => {}}
        disabled={false}
        placeholder="Message"
        completion={{}}
        onFocus={() => {}}
        onBlur={() => {}}
        handle={createRef()}
      />
    );
  }
  const field = within(render(<Owner />).container).getByRole("textbox", { name: "Message" });
  expect(marks(field)).toEqual([]);
  act(() => setSources.current(skills));
  expect(marks(field)).toEqual(["/code-review"]);
  press(field, { key: "z", ctrlKey: true });
  expect(marks(field)).toEqual(["/code-review"]);
  expect(messageOf(field)).toBe("please /code-review it");
});

it("brings a mark back whole with Undo, and takes it again with Redo", () => {
  const handle = createRef<ComposerEditorHandle>();
  const { field } = mountEditor({ sources: skills, handle });
  type(field, "please /code-review it");
  act(() => handle.current!.write("please  it", 7));
  expect(marks(field)).toEqual([]);
  press(field, { key: "z", ctrlKey: true });
  expect([messageOf(field), marks(field)]).toEqual(["please /code-review it", ["/code-review"]]);
  press(field, { key: "z", ctrlKey: true, shiftKey: true });
  expect([messageOf(field), marks(field)]).toEqual(["please  it", []]);
});

it("marks nothing while an input method composes, and marks once it ends", () => {
  const { field } = mountEditor({ sources: skills });
  type(field, "");
  act$(field, () => fireEvent.compositionStart(field, { data: "に" }));
  type(field, "/code-review にほん");
  expect(marks(field)).toEqual([]);
  act$(field, () => fireEvent.compositionEnd(field, { data: "にほん" }));
  type(field, "/code-review にほん");
  expect(marks(field)).toEqual(["/code-review"]);
});

it("draws each kind as its own mark: skill, connector with its image's letter, member and picked file", () => {
  const { field } = mountEditor({
    sources: { ...skills, connectors: [{ name: "linear", title: "Linear", logo: null }], members: [{ key: "rini", name: "Rini" }], files: ["src/app.ts"] },
  });
  type(field, "@Rini, ask @linear to /code-review src/app.ts now");
  expect(marks(field)).toEqual(["Rini", "LLinear", "/code-review", "app.ts"]);
  expect(field.querySelector("[data-connector] .connector-logo-letter")?.textContent).toBe("L");
  expect(field.querySelector("mark.skill-token")?.getAttribute("data-skill")).toBe("code-review");
});
