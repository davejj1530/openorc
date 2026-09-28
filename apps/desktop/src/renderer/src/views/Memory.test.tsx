import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { Memory as MemoryEntry, MemorySettings } from "@openorc/protocol";
import { rpcParams } from "@openorc/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Memory } from "./Memory";
import { core } from "../lib/rpc";
import { queryClient } from "../lib/query";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onInvalidate: vi.fn(), onReady: vi.fn() } }));
vi.mock("../components/TopBar", () => ({ TopBar: () => null }));
let saved: MemorySettings;
let entries: MemoryEntry[];
let failSave: boolean;
let failList: boolean;
let failSettings: boolean;
beforeEach(() => {
  queryClient.setDefaultOptions({ queries: { retry: false } });
  saved = { enabled: false, provider: "off", model: null, hasApiKey: false, resolved: null, automatic: [], reason: null };
  entries = [
    {
      id: "one",
      projectId: "project",
      scope: "project",
      type: "lesson",
      title: "Retain the command",
      body: "Run the targeted check first.",
      source: "agent",
      topicKey: "test/check",
      status: "active",
      sourceRunId: null,
      sourceTaskId: null,
      evidenceCount: 2,
      confidence: 0.8,
      files: [],
      createdAt: Date.now() - 86400000 * 4,
      updatedAt: Date.now() - 86400000,
      lastConfirmedAt: Date.now() - 86400000,
    },
    {
      id: "two",
      projectId: "project",
      scope: "project",
      type: "decision",
      title: "Use project scope",
      body: "Keep project context together.",
      source: "extraction",
      topicKey: null,
      status: "active",
      sourceRunId: null,
      sourceTaskId: null,
      evidenceCount: 1,
      confidence: 0.8,
      files: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastConfirmedAt: Date.now(),
    },
  ];
  failSave = failList = failSettings = false;
  vi.mocked(core.call).mockImplementation(async (method, params) => {
    if (method === "projects.list")
      return [
        { id: "project", name: "Fixture project" },
        { id: "other", name: "Other project" },
      ] as never;
    if (method === "memory.settings.get") {
      if (failSettings) throw Error("Offline");
      return { ...saved };
    }
    if (method === "memory.settings.set" && "enabled" in params) {
      if (failSave) throw Error("Could not persist");
      saved = { ...saved, enabled: params.enabled! };
      return { ...saved };
    }
    if (method === "memory.list") {
      if (failList) throw Error("Offline");
      const input = rpcParams["memory.list"].parse(params);
      const matching = entries.filter((m) => m.projectId === input.projectId && (!input.types || input.types.includes(m.type)) && (!input.sources || input.sources.includes(m.source)));
      const offset = input.offset ?? 0;
      return matching.slice(offset, offset + (input.limit ?? 200));
    }
    if (method === "memory.search") {
      const input = rpcParams["memory.search"].parse(params);
      return entries.filter((e) => e.projectId === input.projectId && e.body.toLowerCase().includes(input.query.toLowerCase())).slice(0, input.limit ?? 12);
    }
    if (method === "memory.update" && "patch" in params && "id" in params) {
      entries = entries.map((e) => (e.id === params.id ? ({ ...e, ...params.patch } as MemoryEntry) : e));
      return entries.find((e) => e.id === params.id)!;
    }
    if (method === "memory.remove" && "id" in params) {
      entries = entries.filter((e) => e.id !== params.id);
      return null;
    }
    throw Error(`Unexpected RPC ${method}`);
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});
function show() {
  render(
    <QueryClientProvider client={queryClient}>
      <Memory />
    </QueryClientProvider>,
  );
}
function fillEntries(count: number) {
  const template = entries[0]!;
  entries = Array.from({ length: count }, (_, index) => ({ ...template, id: String(index), title: `Memory ${index + 1}` }));
}

it("loads small pages on demand and moves forward and backward to the final page", async () => {
  fillEntries(56);
  show();
  await screen.findByRole("article", { name: "Memory 1" });
  expect(screen.getAllByRole("article")).toHaveLength(25);
  expect(core.call).toHaveBeenCalledWith("memory.list", { projectId: "project", limit: 26, offset: 0 });
  expect(screen.getByRole("button", { name: "Previous page" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("1–25 saved memories")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  await screen.findByRole("article", { name: "Memory 26" });
  expect(screen.getAllByRole("article")).toHaveLength(25);
  expect(screen.queryByRole("article", { name: "Memory 1" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  await screen.findByRole("article", { name: "Memory 51" });
  expect(screen.getAllByRole("article")).toHaveLength(6);
  expect(screen.getByText("51–56 saved memories")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Next page" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
  await screen.findByRole("article", { name: "Memory 26" });
  expect(screen.getByText("Page 2")).toBeTruthy();
  expect(
    vi
      .mocked(core.call)
      .mock.calls.filter(([method]) => method === "memory.list")
      .map(([, params]) => params),
  ).toEqual(
    expect.arrayContaining([
      { projectId: "project", limit: 26, offset: 0 },
      { projectId: "project", limit: 26, offset: 25 },
      { projectId: "project", limit: 26, offset: 50 },
    ]),
  );
});

it("finds browse filter matches beyond the old 500-entry cap and resets paging", async () => {
  fillEntries(526);
  entries[525] = { ...entries[525]!, source: "user", type: "command" };
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
  await screen.findByRole("article", { name: "Memory 26" });
  fireEvent.change(screen.getByLabelText("Memory source"), { target: { value: "user" } });
  await screen.findByRole("article", { name: "Memory 526" });
  expect(screen.getAllByRole("article")).toHaveLength(1);
  expect(core.call).toHaveBeenCalledWith("memory.list", { projectId: "project", limit: 26, offset: 0, sources: ["user"] });
  fireEvent.change(screen.getByLabelText("Memory type"), { target: { value: "command" } });
  await screen.findByRole("article", { name: "Memory 526" });
  expect(core.call).toHaveBeenCalledWith("memory.list", { projectId: "project", limit: 26, offset: 0, sources: ["user"], types: ["command"] });
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  await screen.findByRole("article", { name: "Memory 1" });
  expect(screen.getByText("Page 1")).toBeTruthy();
});

it.each(["Memory type", "Project"])("resets to the first page when %s changes", async (label) => {
  fillEntries(55);
  entries.push({ ...entries[0]!, id: "other-entry", projectId: "other", title: "Other project memory" });
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
  await screen.findByRole("article", { name: "Memory 26" });
  fireEvent.change(screen.getByLabelText(label), { target: { value: label === "Project" ? "other" : "lesson" } });
  await screen.findByRole("article", { name: label === "Project" ? "Other project memory" : "Memory 1" });
  expect(screen.queryByText("Page 2")).toBeNull();
});

it("pages ranked search results without fetching browse pages and resets when the query changes", async () => {
  fillEntries(60);
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
  await screen.findByRole("article", { name: "Memory 26" });
  const browseCalls = vi.mocked(core.call).mock.calls.filter(([method]) => method === "memory.list").length;
  fireEvent.change(screen.getByLabelText("Search memories"), { target: { value: "targeted" } });
  await screen.findByText(/1–25 matching memories/);
  expect(screen.getByText("Page 1")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  await screen.findByRole("article", { name: "Memory 26" });
  expect(screen.getAllByRole("article")).toHaveLength(25);
  expect(screen.getByRole("button", { name: "Next page" }).hasAttribute("disabled")).toBe(true);
  expect(vi.mocked(core.call).mock.calls.filter(([method]) => method === "memory.search")).toHaveLength(1);
  fireEvent.change(screen.getByLabelText("Search memories"), { target: { value: "check" } });
  await screen.findByRole("article", { name: "Memory 1" });
  expect(screen.getByText("Page 1")).toBeTruthy();
  expect(vi.mocked(core.call).mock.calls.filter(([method]) => method === "memory.list")).toHaveLength(browseCalls);
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  await screen.findByText("1–25 saved memories");
  expect(screen.getByText("Page 1")).toBeTruthy();
});

it("returns to the previous page after deleting the only entry on the last page", async () => {
  fillEntries(26);
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
  const item = await screen.findByRole("article", { name: "Memory 26" });
  fireEvent.pointerDown(within(item).getByRole("button", { name: "Actions for Memory 26" }), { pointerType: "mouse", button: 0 });
  fireEvent.click(within(item).getByRole("button", { name: "Actions for Memory 26" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
  await screen.findByRole("article", { name: "Memory 1" });
  expect(screen.getAllByRole("article")).toHaveLength(25);
  expect(screen.queryByText("No saved memories yet")).toBeNull();
  expect(screen.queryByRole("navigation", { name: "Memory pagination" })).toBeNull();
});

it("keeps paging recoverable when the next page fails to load", async () => {
  fillEntries(26);
  show();
  await screen.findByRole("button", { name: "Next page" });
  failList = true;
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  await screen.findByText(/Could not load memories/);
  expect(screen.getByRole("button", { name: "Previous page" }).hasAttribute("disabled")).toBe(false);
  failList = false;
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("article", { name: "Memory 26" });
  expect(screen.getByText("Page 2")).toBeTruthy();
});

it("keeps the acknowledged On state after a failed Off save and retries the same choice", async () => {
  saved.enabled = true;
  failSave = true;
  show();
  await screen.findByText("OpenOrc memory is on");
  fireEvent.click(screen.getByRole("switch", { name: "OpenOrc memory" }));
  await screen.findByRole("alert");
  expect(screen.getByText("OpenOrc memory is on")).toBeTruthy();
  expect((screen.getByRole("switch", { name: "OpenOrc memory" }) as HTMLInputElement).checked).toBe(true);
  failSave = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
  await screen.findByText("OpenOrc memory is off");
  expect(vi.mocked(core.call).mock.calls.filter(([method]) => method === "memory.settings.set")).toEqual([
    ["memory.settings.set", { enabled: false }],
    ["memory.settings.set", { enabled: false }],
  ]);
});
it("filters by type and source, clears filters, and searches retained entries while Off", async () => {
  show();
  await screen.findByRole("article", { name: "Retain the command" });
  fireEvent.change(screen.getByLabelText("Memory source"), { target: { value: "extraction" } });
  await screen.findByRole("article", { name: "Use project scope" });
  expect(screen.queryByRole("article", { name: "Retain the command" })).toBeNull();
  fireEvent.change(screen.getByLabelText("Memory type"), { target: { value: "lesson" } });
  expect(await screen.findByText("No matching memories")).toBeTruthy();
  fireEvent.click(screen.getAllByRole("button", { name: "Clear filters" })[0]!);
  expect(screen.getAllByRole("article")).toHaveLength(2);
  fireEvent.change(screen.getByRole("textbox", { name: "Search memories" }), { target: { value: "targeted" } });
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("memory.search", { projectId: "project", query: "targeted", limit: 50 }));
  await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(1));
  expect(screen.getByText("OpenOrc memory is off")).toBeTruthy();
});
it("supports editing and deleting retained memory while Off", async () => {
  show();
  const item = await screen.findByRole("article", { name: "Retain the command" });
  fireEvent.pointerDown(within(item).getByRole("button", { name: "Actions for Retain the command" }), { pointerType: "mouse", button: 0 });
  fireEvent.click(within(item).getByRole("button", { name: "Actions for Retain the command" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
  fireEvent.change(screen.getByLabelText("Memory title"), { target: { value: "Corrected command" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  const updated = await screen.findByRole("article", { name: "Corrected command" });
  fireEvent.pointerDown(within(updated).getByRole("button", { name: "Actions for Corrected command" }), { pointerType: "mouse", button: 0 });
  fireEvent.click(within(updated).getByRole("button", { name: "Actions for Corrected command" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
  await waitFor(() => expect(screen.queryByRole("article", { name: "Corrected command" })).toBeNull());
});
it("gives a memory-specific error and recovers after retry", async () => {
  failList = true;
  show();
  const error = await screen.findByRole("alert");
  expect(error.textContent).toContain("Could not load memories");
  failList = false;
  fireEvent.click(within(error).getByRole("button", { name: "Try again" }));
  await screen.findByRole("article", { name: "Retain the command" });
});
it("does not pretend an unknown setting is Off", async () => {
  failSettings = true;
  show();
  await screen.findByText(/Could not check memory status/);
  expect(screen.queryByText("OpenOrc memory is off")).toBeNull();
  expect(screen.queryByRole("switch")).toBeNull();
});
it("explains the empty Off state without promising automatic extraction", async () => {
  entries = [];
  show();
  await screen.findByText("No saved memories yet");
  expect(await screen.findByText(/Turn on OpenOrc memory above/)).toBeTruthy();
});
