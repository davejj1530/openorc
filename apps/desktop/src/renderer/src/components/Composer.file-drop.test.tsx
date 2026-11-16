import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import type { FileScope } from "@openorc/protocol";
import { endFileDrag, insertReference, startFileDrag } from "../lib/file-drag";
import { Composer, type ComposerProps } from "./Composer";

afterEach(() => {
  endFileDrag();
  cleanup();
});

const here: FileScope = { kind: "thread", id: "here" };

const BASE: ComposerProps = {
  value: "",
  onChange: () => {},
  onSubmit: async () => {},
  placeholder: "Message",
  model: null,
  onModel: () => {},
  mode: "act",
  onMode: () => {},
  permission: "trusted",
  onPermission: () => {},
  location: { label: null, branch: null },
  fileSearch: here,
};

function mount(overrides: Partial<ComposerProps> = {}) {
  const props: ComposerProps = { ...BASE, ...overrides };
  function ControlledComposer() {
    const [value, setValue] = useState(props.value);
    return <Composer {...props} value={value} onChange={setValue} />;
  }
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ControlledComposer />
    </QueryClientProvider>,
  );
}

function dragData() {
  const data = new Map<string, string>();
  return {
    effectAllowed: "all",
    dropEffect: "none",
    items: [] as unknown[],
    files: [] as File[],
    get types() {
      return [...data.keys()];
    },
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
  };
}

const message = () => screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
const shell = () => document.querySelector(".composer-shell")!;

/** A row of the Files tool picked up, held over the composer, and let go there. */
function dragOnto(scope: FileScope, path: string, folder = false) {
  const dataTransfer = dragData();
  startFileDrag(dataTransfer as unknown as DataTransfer, scope, path, folder);
  fireEvent.dragEnter(shell(), { dataTransfer });
  const accepted = !fireEvent.dragOver(shell(), { dataTransfer });
  const label = document.querySelector(".composer-drop-zone")?.textContent ?? null;
  fireEvent.drop(shell(), { dataTransfer });
  return { accepted, label };
}

it("mentions a file dragged from its own folder at the caret, a word of its own, and keeps writing after it", async () => {
  mount({ value: "look at before lunch" });
  message().focus();
  message().setSelectionRange(7, 7);
  const drop = dragOnto(here, "src/cart.ts");
  expect(drop).toEqual({ accepted: true, label: "Release to mention cart.ts" });
  expect(message().value).toBe("look at src/cart.ts before lunch");
  await waitFor(() => expect(message().selectionStart).toBe("look at src/cart.ts".length));
  expect(document.activeElement).toBe(message());
  expect(document.querySelector(".composer-drop-zone")).toBeNull();
});

it("mentions a file dropped on a restored draft the prompt was never clicked in at the draft's end", () => {
  mount({ value: "look at" });
  expect(message().selectionEnd).toBe("look at".length);
  expect(dragOnto(here, "src/cart.ts").accepted).toBe(true);
  expect(message().value).toBe("look at src/cart.ts ");
});

it("mentions a folder with its trailing slash", () => {
  mount();
  expect(dragOnto(here, "src/lib", true).label).toBe("Release to mention lib/");
  expect(message().value).toBe("src/lib/ ");
});

it("refuses a file from another conversation's folder, where its path names something else", () => {
  mount({ value: "hello" });
  expect(dragOnto({ kind: "thread", id: "elsewhere" }, "src/cart.ts")).toEqual({ accepted: false, label: null });
  expect(message().value).toBe("hello");
});

it("refuses a file while the prompt can't be written in, or with no folder to read it from", () => {
  mount({ value: "hello", busy: true });
  expect(dragOnto(here, "src/cart.ts").accepted).toBe(false);
  cleanup();
  mount({ value: "hello", fileSearch: undefined });
  expect(dragOnto(here, "src/cart.ts").accepted).toBe(false);
  expect(message().value).toBe("hello");
});

it("attaches files dragged in from the system, saying how many", () => {
  mount({ attachmentsDisabledReason: "Attachments are off here." });
  const dataTransfer = dragData();
  dataTransfer.setData("Files", "");
  dataTransfer.items.push({}, {});
  dataTransfer.files.push(new File(["a"], "a.txt"), new File(["b"], "b.txt"));
  fireEvent.dragEnter(shell(), { dataTransfer });
  expect(fireEvent.dragOver(shell(), { dataTransfer })).toBe(false);
  expect(document.querySelector(".composer-drop-zone")?.textContent).toBe("Release to attach 2 files");
  fireEvent.drop(shell(), { dataTransfer });
  expect(document.querySelector(".composer-drop-zone")).toBeNull();
  // The files reached the composer's attachments, which say why they can't be added here.
  expect(screen.getByText("Attachments are off here.")).toBeTruthy();
  expect(message().value).toBe("");
});

it("takes the overlay away once a file is carried back out, past the composer's own parts", () => {
  mount();
  const dataTransfer = dragData();
  startFileDrag(dataTransfer as unknown as DataTransfer, here, "src/cart.ts", false);
  const overlay = () => document.querySelector(".composer-drop-zone");
  fireEvent.dragEnter(shell(), { dataTransfer });
  // Into the prompt: its enter comes before the shell's leave, so the drag is still inside.
  fireEvent.dragEnter(message(), { dataTransfer });
  fireEvent.dragLeave(shell(), { dataTransfer });
  expect(overlay()).not.toBeNull();
  fireEvent.dragLeave(message(), { dataTransfer });
  expect(overlay()).toBeNull();
  expect(message().value).toBe("");
});

it("ignores a drag that only carries the private type, as from another window", () => {
  mount({ value: "hello" });
  const dataTransfer = dragData();
  dataTransfer.setData("application/x-openorc-file", "src/cart.ts");
  fireEvent.dragEnter(shell(), { dataTransfer });
  expect(fireEvent.dragOver(shell(), { dataTransfer })).toBe(true);
  fireEvent.drop(shell(), { dataTransfer });
  expect(message().value).toBe("hello");
});

it.each([
  ["", 0, "src/a.ts ", 9],
  ["see", 3, "see src/a.ts ", 13],
  ["see ", 4, "see src/a.ts ", 13],
  ["see\n", 4, "see\nsrc/a.ts ", 13],
  ["see and", 3, "see src/a.ts and", 12],
  ["seeand", 3, "see src/a.ts and", 13],
])("sets a mention off from the words around it in %j at %i", (text, at, expected, caret) => {
  expect(insertReference(text, at, "src/a.ts")).toEqual({ text: expected, caret });
});
