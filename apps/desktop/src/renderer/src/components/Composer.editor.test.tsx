import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readDraft } from "../lib/drafts";
import { core } from "../lib/rpc";
import { Composer, type ComposerProps } from "./Composer";
import { act$, caretOf, messageOf, placeCaret, press, type } from "./composer-editor/testing";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BASE: ComposerProps = {
  value: "",
  onChange: () => {},
  onSubmit: async () => {},
  placeholder: "Message Claude…",
  model: null,
  onModel: () => {},
  mode: "act",
  onMode: () => {},
  permission: "trusted",
  onPermission: () => {},
  location: { label: null, branch: null },
};

function mount(overrides: Partial<ComposerProps> = {}) {
  const props = { ...BASE, ...overrides };
  function Owner() {
    const [value, setValue] = useState(props.value);
    return <Composer {...props} value={value} onChange={setValue} />;
  }
  const view = render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Owner />
    </QueryClientProvider>,
  );
  return { ...view, field: screen.getByRole("textbox", { name: "Message" }) };
}

describe("the message box", () => {
  it("is a multi-line text box named Message that says its placeholder, spellchecks, and shows the placeholder only while empty", () => {
    const { field } = mount();
    expect([field.getAttribute("aria-multiline"), field.getAttribute("aria-placeholder"), field.getAttribute("spellcheck")]).toEqual(["true", "Message Claude…", "true"]);
    expect(screen.getByText("Message Claude…")).toBeTruthy();
    type(field, "Hello");
    expect(screen.queryByText("Message Claude…")).toBeNull();
  });

  it("sends on Enter, starts a line on Shift+Enter, and sends during the turn on Cmd+Enter", async () => {
    const onSubmit = vi.fn(async () => {});
    const { field } = mount({ onSubmit, queueing: true, steerable: true });
    type(field, "first");
    press(field, { key: "Enter", shiftKey: true });
    expect(messageOf(field)).toBe("first\n");
    press(field, { key: "Enter", metaKey: true });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("first", [], true));
  });

  it("never sends on the Enter that commits Japanese, Chinese or Korean input", async () => {
    const onSubmit = vi.fn(async () => {});
    const { field } = mount({ onSubmit, value: "日本" });
    act$(field, () => fireEvent.compositionStart(field, { data: "語" }));
    press(field, { key: "Enter", keyCode: 229, isComposing: true });
    act$(field, () => fireEvent.compositionEnd(field, { data: "語" }));
    press(field, { key: "Enter", keyCode: 229 });
    await act(async () => {});
    expect(onSubmit).not.toHaveBeenCalled();
    press(field, { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("日本", [], false));
  });

  it("cannot be written in while a send is pending, and says so to a screen reader", () => {
    const { field } = mount({ value: "Sending this", busy: true });
    expect(field.getAttribute("aria-disabled")).toBe("true");
    expect(field.getAttribute("contenteditable")).toBe("false");
  });

  it("takes focus as the New thread screen opens, with the caret after a kept draft", async () => {
    const { field } = mount({ value: "Kept from before", autoFocus: true, presentation: "new-thread" });
    await act(async () => {});
    expect(document.activeElement).toBe(field);
    expect(caretOf(field)).toBe("Kept from before".length);
  });
});

describe("mentions as marks", () => {
  it("marks an Orcling picked from the @ list, and sends its name as the words", async () => {
    const onSubmit = vi.fn(async () => {});
    const { field } = mount({ onSubmit, mentions: [{ key: "rini", name: "Rini", hint: "Orcling" }] });
    type(field, "@Ri");
    press(field, { key: "Enter" });
    expect(messageOf(field)).toBe("@Rini ");
    expect(field.querySelector("[data-member] .mark-pill-name")?.textContent).toBe("Rini");
    type(field, "@Rini check the copy");
    press(field, { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("@Rini check the copy", [], false));
  });

  it("marks a file picked from the @ list, keeps it marked when the draft comes back, and sends its path", async () => {
    vi.spyOn(core, "call").mockImplementation(async (method) => (method === "files.search" ? ["src/app.ts"] : null) as never);
    const draftKey = "editor-file-mention";
    const { field } = mount({ draftKey, fileSearch: { kind: "project", id: "p" } });
    type(field, "look at @app");
    fireEvent.mouseDown(await screen.findByRole("option", { name: "src/app.ts" }));
    expect(messageOf(field)).toBe("look at src/app.ts ");
    await waitFor(() => expect(field.querySelector("[data-file] .mark-pill-name")?.textContent).toBe("app.ts"));
    expect(readDraft(draftKey, { files: [] as string[] }).files).toEqual(["src/app.ts"]);
    cleanup();
    const back = mount({ draftKey, value: "look at src/app.ts and src/other.ts" });
    expect([...back.field.querySelectorAll<HTMLElement>("[data-file]")].map((mark) => mark.dataset["file"])).toEqual(["src/app.ts"]);
  });

  it("lands a skill typed in full once the caret moves on, so Backspace right after typing it takes one letter", () => {
    const { field } = mount({ commands: [{ name: "code-review", hint: "Review", insert: true, prefix: "/" }] });
    type(field, "run /code-review");
    expect(field.querySelector("mark.skill-token")).toBeNull();
    placeCaret(field, 0);
    expect(field.querySelector("mark.skill-token")?.textContent).toBe("/code-review");
  });
});
