// @vitest-environment jsdom
import type { RpcMethod, ThreadCollaboration, ThreadSummary } from "@openorc/protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { HandoffCard } from "./HandoffCard";

const mac = vi.hoisted(() => ({ phone: null as FakeMac | null, calls: [] as [string, unknown][], refusal: null as string | null }));
vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac((method: RpcMethod, params) => {
    mac.calls.push([method, params]);
    return mac.refusal ? Promise.reject(new Error(mac.refusal)) : Promise.resolve(null);
  });
  return mac.phone.module;
});

afterEach(() => {
  cleanup();
  mac.calls = [];
  mac.refusal = null;
});

const MARA = { id: "u-mara", name: "Mara Okafor", image: null };
const RILEY = { id: "u-riley", name: "Riley Chen", image: null };
const handoff = (more: Partial<NonNullable<ThreadCollaboration["handoff"]>>) => ({
  code: "handoff_command" as const,
  message: "Mara's command is still running. Stop it before starting your turn.",
  responsible: MARA,
  commandIds: [],
  retrySave: false,
  stopWork: false,
  note: null,
  ...more,
});
const thread = (block: ThreadCollaboration["handoff"]) =>
  ({
    id: "t1",
    activity: "idle",
    owner: {
      brain: "hosted",
      reach: "live",
      heardAt: 0,
      startedBy: { name: "Mara Okafor", image: null },
      collaboration: {
        viewer: RILEY,
        canWrite: true,
        live: null,
        send: "blocked",
        handoff: block,
        canPostNote: false,
        canStop: false,
        ask: null,
        queue: [],
        mentions: { unread: false, firstUnreadNoteId: null },
        noteHead: 0,
      },
    },
  }) as unknown as ThreadSummary;
const show = (block: ThreadCollaboration["handoff"]) => render(<HandoffCard thread={thread(block)} />, { wrapper: mac.phone!.wrapper });

it("stops each command the last turn left running, from the card that says what holds the turn", async () => {
  show(handoff({ commandIds: ["c1", "c2"] }));
  expect(screen.getByText("Mara's command is still running. Stop it before starting your turn.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Stop commands" }));
  await waitFor(() =>
    expect(mac.calls).toEqual([
      ["threads.stopCommand", { id: "t1", commandId: "c1" }],
      ["threads.stopCommand", { id: "t1", commandId: "c2" }],
    ]),
  );
});

it("retries the save and stops the work, and says the server's words when a move fails", async () => {
  show(handoff({ code: "handoff_save", message: "The thread's work could not be saved. Riley can retry the save.", responsible: RILEY, retrySave: true }));
  expect(screen.getByText("The thread's work could not be saved.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
  await waitFor(() => expect(mac.calls).toEqual([["threads.retrySave", { threadId: "t1" }]]));
  cleanup();
  mac.refusal = "That work already ended.";
  show(handoff({ code: "handoff_unavailable", message: "Only Mara can run the agent in this cloud thread for now.", stopWork: true }));
  fireEvent.click(screen.getByRole("button", { name: "Stop work" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "That work already ended.");
});

it("gives a reader with nothing to press the words alone, and nothing for a thread no handoff holds", () => {
  const note = { to: MARA, text: "@Mara the thread's work could not be saved. Can you retry the save?", mention: { start: 0, end: 5 } };
  show(handoff({ code: "handoff_save", message: "The thread's work could not be saved. Mara can retry the save.", note }));
  expect(screen.getByText("The thread's work could not be saved. Mara can retry the save.")).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
  cleanup();
  const { container } = show(null);
  expect(container.textContent).toBe("");
});
