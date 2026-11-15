import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ThreadTaggable } from "@openorc/protocol";
import { readDraft, writeDraft } from "../lib/drafts";
import { core } from "../lib/rpc";
import { Composer, type ComposerHandle, type ComposerNotes, type ComposerProps } from "./Composer";
import { messageOf, type } from "./composer-editor/testing";

const ADA: ThreadTaggable = { id: "u-ada", name: "Ada Park", image: null, address: null };
const BEN: ThreadTaggable = { id: "u-ben", name: "Ben Ito", image: null, address: null };
const READER: ThreadTaggable = { id: "u-reader", name: "Ana Reader", image: null, address: null };
const TIP = "Posts to the thread. The agent reads it on its next turn.";

const BASE: ComposerProps = {
  value: "",
  onChange: () => {},
  onSubmit: async () => {},
  placeholder: "Message Codex…",
  model: null,
  onModel: () => {},
  mode: "act",
  onMode: () => {},
  permission: "trusted",
  onPermission: () => {},
  location: { label: null, branch: null },
};

let draftCount = 0;
beforeEach(() => {
  draftCount++;
  vi.spyOn(core, "call").mockImplementation(async (method) => (method === "threads.people" ? { people: [ADA, BEN, READER] } : null) as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(overrides: Partial<ComposerProps> = {}, post: ComposerNotes["post"] = vi.fn(async () => {})) {
  const handle = createRef<ComposerHandle>();
  const notes: ComposerNotes = { threadId: "thread-1", viewerId: READER.id, post };
  const props: ComposerProps = { ...BASE, draftKey: `notes-${draftCount}`, notes, ...overrides };
  function Owner() {
    const [value, setValue] = useState(props.value);
    return <Composer {...props} handle={handle} value={value} onChange={setValue} />;
  }
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Owner />
    </QueryClientProvider>,
  );
  return { field: screen.getByRole("textbox", { name: "Message" }), handle, post, props };
}

async function tagAda(field: HTMLElement) {
  type(field, "@Ad");
  fireEvent.mouseDown(await screen.findByRole("option", { name: "Ada Park" }));
}

it("offers the people who read the thread under People as @ is typed, never the reader, and draws a picked one by name", async () => {
  const { field } = mount();
  type(field, "@");
  const list = await screen.findByRole("listbox");
  expect(list.textContent).toContain("People");
  expect(screen.getByRole("option", { name: "Ben Ito" })).toBeTruthy();
  expect(screen.queryByRole("option", { name: "Ana Reader" })).toBeNull();
  type(field, "@Ad");
  fireEvent.mouseDown(await screen.findByRole("option", { name: "Ada Park" }));
  expect(messageOf(field)).toBe("@[user:u-ada] ");
  expect(field.querySelector("[data-person]")?.textContent).toBe("@Ada Park");
});

it("posts a draft that tags a person as a note with its names and their places, never to the agent, then clears it", async () => {
  const onSubmit = vi.fn(async () => {});
  const { field, post } = mount({ onSubmit });
  await tagAda(field);
  type(field, "@[user:u-ada] Check the column order");
  const key = screen.getByRole("button", { name: "Post note" });
  expect(key.getAttribute("data-tip")).toBe(TIP);
  fireEvent.click(key);
  await waitFor(() => expect(post).toHaveBeenCalledWith({ text: "@Ada Park Check the column order", mentions: [{ userId: "u-ada", start: 0, end: 9 }] }));
  expect(onSubmit).not.toHaveBeenCalled();
  await waitFor(() => expect(messageOf(field)).toBe(""));
});

it("keeps Stop beside Post note while a turn runs, never Send now or Queue", async () => {
  const { field } = mount({ queueing: true, liveByDefault: true, steerable: true, live: { runId: "run", working: true } });
  await tagAda(field);
  expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Post note" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Queue" })).toBeNull();
});

it("goes back to sending to the agent once the last tag is taken out", async () => {
  const onSubmit = vi.fn(async () => {});
  const { field } = mount({ onSubmit });
  await tagAda(field);
  type(field, "Check the column order");
  expect(screen.queryByRole("button", { name: "Post note" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("Check the column order", [], false));
});

it("keeps the draft and says the server's words when the note is refused", async () => {
  const words = "Someone you tagged no longer has access to this project. Choose the people again.";
  const { field } = mount(
    {},
    vi.fn(async () => Promise.reject(new Error(words))),
  );
  await tagAda(field);
  type(field, "@[user:u-ada] Check it");
  fireEvent.click(screen.getByRole("button", { name: "Post note" }));
  expect((await screen.findByRole("alert")).textContent).toBe(words);
  expect(messageOf(field)).toBe("@[user:u-ada] Check it");
});

it("holds Post note while files are attached, saying why, and keeps the files", async () => {
  const draftKey = `notes-files-${draftCount}`;
  writeDraft(draftKey, { attachments: [{ path: "/hosted/files/a/notes.pdf", url: null, name: "notes.pdf" }] });
  const { field, post } = mount({ draftKey });
  await tagAda(field);
  const key = screen.getByRole("button", { name: "Post note" });
  expect([key.hasAttribute("disabled"), key.getAttribute("data-tip")]).toEqual([true, "Remove the attachments to post a note."]);
  fireEvent.click(key);
  await act(async () => {});
  expect(post).not.toHaveBeenCalled();
  expect(readDraft(draftKey, { attachments: [] as unknown[] }).attachments).toHaveLength(1);
});

it("keeps a tagged person named when the draft comes back", async () => {
  const draftKey = `notes-back-${draftCount}`;
  const first = mount({ draftKey });
  await tagAda(first.field);
  cleanup();
  vi.mocked(core.call).mockImplementation(async () => null as never);
  const back = mount({ draftKey, value: "@[user:u-ada] Check it" });
  expect(back.field.querySelector("[data-person]")?.textContent).toBe("@Ada Park");
  expect(screen.getByRole("button", { name: "Post note" })).toBeTruthy();
});

it("posts a reply as a reply to its note while the draft still tags its author", async () => {
  const { field, handle, post } = mount();
  act(() => handle.current!.tag({ id: BEN.id, name: BEN.name, image: null }, "note-1"));
  type(field, "@[user:u-ben] The columns match.");
  fireEvent.click(screen.getByRole("button", { name: "Post note" }));
  await waitFor(() => expect(post).toHaveBeenCalledWith({ text: "@Ben Ito The columns match.", mentions: [{ userId: "u-ben", start: 0, end: 8 }], replyTo: "note-1" }));
  act(() => handle.current!.tag({ id: BEN.id, name: BEN.name, image: null }, "note-2"));
  await tagAda(field);
  type(field, "@[user:u-ada] Not a reply any more");
  fireEvent.click(screen.getByRole("button", { name: "Post note" }));
  await waitFor(() => expect(post).toHaveBeenLastCalledWith({ text: "@Ada Park Not a reply any more", mentions: [{ userId: "u-ada", start: 0, end: 9 }] }));
});

it("starts a reply with its author's tag before what is written, drawn by name", () => {
  const { field, handle } = mount({ value: "The columns match." });
  act(() => handle.current!.tag({ id: BEN.id, name: BEN.name, image: null }));
  expect(messageOf(field)).toBe("@[user:u-ben] The columns match.");
  expect(field.querySelector("[data-person]")?.textContent).toBe("@Ben Ito");
});

it("writes the server's note to the person who can release a block as a note to post, their tag in place", async () => {
  const { field, handle, post } = mount();
  const note = { to: { id: BEN.id, name: BEN.name, image: null }, text: "@Ben the thread's work could not be saved. Can you retry the save?", mention: { start: 0, end: 4 } };
  act(() => handle.current!.note(note));
  expect(messageOf(field)).toBe("@[user:u-ben] the thread's work could not be saved. Can you retry the save?");
  fireEvent.click(screen.getByRole("button", { name: "Post note" }));
  await waitFor(() => expect(post).toHaveBeenCalledWith({ text: "@Ben Ito the thread's work could not be saved. Can you retry the save?", mentions: [{ userId: "u-ben", start: 0, end: 8 }] }));
});

it("asks for no readiness for a draft a reply starts, which is a note, but does for words to the agent", () => {
  const onReady = vi.fn();
  const { field, handle } = mount({ onReady });
  act(() => handle.current!.tag({ id: BEN.id, name: BEN.name, image: null }));
  expect(onReady).not.toHaveBeenCalledWith("words");
  type(field, "");
  type(field, "Check the column order");
  expect(onReady).toHaveBeenCalledWith("words");
});

it("treats words like a tag as words in a thread without notes, and asks it for no people", async () => {
  const { field } = mount({ notes: null, value: "@[user:u-ada] hello" });
  expect(screen.queryByRole("button", { name: "Post note" })).toBeNull();
  type(field, "@Ad");
  await act(async () => {});
  expect(vi.mocked(core.call).mock.calls.map(([method]) => method)).not.toContain("threads.people");
});
