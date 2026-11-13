// @vitest-environment jsdom
import { defaultOrclingLook, type OrclingChatSummary, type ThreadSummary } from "@openorc/protocol";
import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeMac, type FakeMac } from "../test-fixtures/fake-mac";

const mac = vi.hoisted(() => ({ current: null as unknown as FakeMac, answer: (_method: string, _params?: unknown): unknown => undefined }));
vi.mock("../client", () => mac.current.module);
vi.mock("expo-router", () => ({ router: { push: vi.fn(), back: vi.fn() }, useLocalSearchParams: () => ({ id: "pip" }), useIsFocused: () => true }));
// The native Markdown view has no test build: the text it was given stands in for it.
vi.mock("../thread/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <span>{text}</span> }));

const now = Date.UTC(2026, 10, 9, 12);
const thread = (activity: ThreadSummary["activity"], unread: boolean) => ({ activity, unread, session: { status: "idle" }, backgroundCommands: [] }) as unknown as ThreadSummary;
const chat = (name: string, extra: Partial<OrclingChatSummary>): OrclingChatSummary => ({
  id: name.toLowerCase(),
  name,
  look: defaultOrclingLook,
  threadId: `home-${name.toLowerCase()}`,
  thread: thread("idle", false),
  last: null,
  ...extra,
});
const chats = [
  chat("Pip", { thread: thread("idle", true), last: { id: "m1", role: "assistant", text: "The build is green.", createdAt: now - 60_000 } }),
  chat("Rex", { thread: thread("running", false), last: { id: "m2", role: "user", text: "Tidy the badges", createdAt: now - 3_600_000 } }),
  chat("Sol", {}),
];

/** One Mac for the file, as the mocked client is read once; each test says how it answers. */
mac.current = fakeMac(async (method, params) => {
  const result = mac.answer(method, params);
  if (result instanceof Error) throw result;
  return result;
});
function given(answer: (method: string, params?: unknown) => unknown) {
  mac.answer = answer;
}

afterEach(() => {
  cleanup();
  mac.current.module.queryClient.clear();
});

describe("the phone's Orclings", () => {
  it("lists each by face, name and newest message, newest first, with a dot while one wants you and a chip while it works", async () => {
    given(() => chats);
    const { OrclingList } = await import("./OrclingList");
    const { byRecent } = await import("./orcling-chats");
    render(<OrclingList chats={byRecent(chats)} top={0} bottom={0} />, { wrapper: mac.current.wrapper });
    const rows = screen.getAllByRole("button").map((row) => row.getAttribute("aria-label"));
    expect(rows).toEqual(["Pip, Unread, The build is green.", "Rex, Working, You: Tidy the badges", "Sol, No messages yet"]);
    expect(screen.getByText("Working")).toBeTruthy();
  });

  it("marks the faces of the Orclings that want you on Threads with a dot", async () => {
    given(() => chats);
    const { OrclingFaces } = await import("./OrclingFaces");
    render(<OrclingFaces chats={chats} />, { wrapper: mac.current.wrapper });
    expect(screen.getAllByRole("button").map((pin) => pin.getAttribute("aria-label"))).toEqual(["Pip, Unread", "Rex, Working", "Sol"]);
    const dotted = screen.getAllByRole("button").map((pin) => pin.querySelector("[data-testid='needs-you']") !== null);
    expect(dotted).toEqual([true, false, false]);
  });

  it("stays out of sight for a Mac too old to list them", async () => {
    const asked: string[] = [];
    given((method) => {
      asked.push(method);
      return method === "orclings.chats" ? new Error("Update OpenOrc on your Mac to see its Orclings here.") : undefined;
    });
    const { useOrclingChats } = await import("./orcling-chats");
    const { result } = renderHook(() => useOrclingChats(), { wrapper: mac.current.wrapper });
    await waitFor(() => expect(asked).toContain("orclings.chats"));
    expect(result.current).toEqual({ chats: [], supported: false });
  });

  it("counts the Orclings that want you on the tab when their faces are off", async () => {
    given(() => chats);
    const { BottomBar } = await import("../home/BottomBar");
    render(<BottomBar tab="threads" tabs={["threads", "orclings"]} onTab={() => undefined} badge={2} action={{ kind: "press", label: "New thread", onPress: () => undefined }} />);
    expect(screen.getByRole("tab", { name: "Orclings, 2 need you" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New thread" })).toBeTruthy();
  });

  it("opens an Orcling's profile with what it runs on, its instructions and memory, and saves a check-in time added on the phone", async () => {
    const saved: unknown[] = [];
    const profile = {
      id: "pip",
      name: "Pip",
      look: defaultOrclingLook,
      settings: { agent: "codex", model: "gpt-6-astra", effort: null, fastMode: false },
      permission: "approve",
      wakes: [{ kind: "startup" }],
      instructions: "Ping me when CI breaks.",
      memories: [{ id: "m1", title: "Prefers short texts", body: "Keeps replies to a line or two.", updatedAt: now }],
    };
    given((method, params) => {
      if (method === "orclings.profile") return profile;
      if (method === "agents.models") return [{ agent: "codex", id: "gpt-6-astra", label: "GPT-6 Astra" }];
      if (method === "orclings.wakes.save") {
        saved.push(params);
        return { ...profile, wakes: (params as { wakes: unknown[] }).wakes };
      }
      return undefined;
    });
    const { OrclingSheet } = await import("./OrclingSheet");
    render(<OrclingSheet />, { wrapper: mac.current.wrapper });
    expect(await screen.findByRole("button", { name: "Model, GPT-6 Astra" })).toBeTruthy();
    expect(screen.getByText("Approve")).toBeTruthy();
    expect(screen.getByText("Ping me when CI breaks.")).toBeTruthy();
    expect(screen.getByText("Prefers short texts")).toBeTruthy();
    screen.getByRole("button", { name: "Add a time" }).click();
    await waitFor(() => expect(saved).toEqual([{ id: "pip", wakes: [{ kind: "startup" }, { kind: "time", at: "09:00", days: [1, 2, 3, 4, 5] }] }]));
    expect(screen.getByRole("button", { name: "Remove the 09:00 check-in" })).toBeTruthy();
  });

  it("shows Tasks as a tab once the Mac lists tasks, and no bar for threads alone", async () => {
    const { BottomBar, homeTabs } = await import("../home/BottomBar");
    expect(homeTabs({ orclings: false, tasks: false })).toEqual(["threads"]);
    expect(homeTabs({ orclings: false, tasks: true })).toEqual(["threads", "tasks"]);
    render(<BottomBar tab="tasks" tabs={homeTabs({ orclings: true, tasks: true })} onTab={() => undefined} badge={0} action={{ kind: "press", label: "New task", onPress: () => undefined }} />);
    expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"))).toEqual(["Threads", "Orclings", "Tasks"]);
  });
});
