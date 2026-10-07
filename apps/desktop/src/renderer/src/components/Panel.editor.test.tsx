import "fake-indexeddb/auto";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Project, RpcMethod, RpcParams, RpcResults, ThreadSummary } from "@openorc/protocol";
import { fakeFileDisk, nthVersion } from "../fixtures/file-disk";
import { useDrafts } from "../lib/file-drafts";
import { useLayout } from "../lib/layout";
import { usePanelSessions } from "../lib/panel-tabs";
import { invalidateTags, queryClient } from "../lib/query";
import { core } from "../lib/rpc";
import { Panel } from "./Panel";

vi.mock("../lib/window", () => ({ useTrafficLights: () => false, useWindowsControls: () => false }));

const project: Project = {
  id: "project",
  name: "Shop",
  rootPath: "/repo",
  gitRemote: null,
  defaultBranch: "main",
  settings: { setupScript: null, worktreeInclude: [], branchPrefix: "openorc", detectedConfigs: [] },
  createdAt: 0,
  updatedAt: 0,
};
const thread = { id: "thread", projectId: project.id, workspaceMode: "current", createdAt: 0 } as ThreadSummary;
const scope = { kind: "thread", id: thread.id } as const;
let disk: ReturnType<typeof fakeFileDisk>;

beforeEach(() => {
  disk = fakeFileDisk();
  disk.set("src/cart.ts", "export const total = 1;\n");
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  useDrafts.setState({ keys: new Set(), ready: true, loaded: new Map(), failed: false });
  vi.stubGlobal("openorc", { browser: { setContext: vi.fn(), onReveal: () => () => {}, close: vi.fn(), navigate: vi.fn() } });
  vi.spyOn(core, "call").mockImplementation(async <M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> => {
    if (method === "files.read") return disk.read((params as RpcParams<"files.read">).path) as RpcResults[M];
    if (method === "files.write") return disk.write(params as RpcParams<"files.write">) as RpcResults[M];
    if (method === "files.format") return { kind: "formatted", text: (params as RpcParams<"files.format">).text.toUpperCase() } as RpcResults[M];
    if (method === "projects.git") return "none" as RpcResults[M];
    return [] as unknown as RpcResults[M];
  });
  usePanelSessions.setState({ sessions: {} });
  usePanelSessions.getState().open(`thread:${thread.id}`, { kind: "file", selection: { path: "src/cart.ts", scope } });
  useLayout.setState({ panelOpen: true, panelTab: "file", panelRequest: null, panelThreadId: thread.id, selectedFile: null, selectedChanges: null, panelExpanded: false, previewUrls: {} });
  render(
    <QueryClientProvider client={queryClient}>
      <Panel context={{ kind: "thread", thread, project }} />
    </QueryClientProvider>,
  );
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** CodeMirror's editable area, named after the file. */
const content = () => screen.findByRole("textbox", { name: "cart.ts" });
const shownText = () => [...document.querySelectorAll(".cm-line")].map((line) => line.textContent).join("\n");
const press = async (init: KeyboardEventInit) => fireEvent.keyDown(await content(), init);

it("saves what was typed in CodeMirror with Cmd+S, against the version it was typed on", async () => {
  await press({ key: "Enter", keyCode: 13 });
  expect(await screen.findByRole("tab", { name: "cart.ts, unsaved changes" })).toBeTruthy();
  expect(await press({ key: "s", keyCode: 83, ctrlKey: true }), "Cmd+S is the editor's").toBe(false);
  await waitFor(() => expect(disk.writes).toEqual([{ scope, path: "src/cart.ts", text: "\nexport const total = 1;\n", expected: { kind: "version", version: nthVersion(1) } }]));
  expect(await screen.findByRole("tab", { name: "cart.ts" })).toBeTruthy();
});

it("takes a disk change into a clean buffer as one undo step", async () => {
  await content();
  disk.set("src/cart.ts", "export const total = 2;\n");
  act(() => invalidateTags(["workspace-diff"], { immediate: true }));
  await waitFor(() => expect(shownText()).toBe("export const total = 2;\n"));
  await press({ key: "z", keyCode: 90, ctrlKey: true });
  expect(shownText()).toBe("export const total = 1;\n");
  expect(await screen.findByRole("tab", { name: "cart.ts, unsaved changes" })).toBeTruthy();
  expect(screen.queryByText("cart.ts changed after you started editing.")).toBeNull();
});

it("puts focus back in the editor after Use new version, so Cmd+Z brings the user's text back", async () => {
  await press({ key: "Enter", keyCode: 13 });
  disk.set("src/cart.ts", "export const total = 2;\n");
  act(() => invalidateTags(["workspace-diff"], { immediate: true }));
  fireEvent.click(await screen.findByRole("button", { name: "Use new version" }));
  await waitFor(() => expect(shownText()).toBe("export const total = 2;\n"));
  expect(document.activeElement).toBe(await content());
  fireEvent.keyDown(document.activeElement!, { key: "z", keyCode: 90, ctrlKey: true });
  expect(shownText()).toBe("\nexport const total = 1;\n");
});

it("formats with Shift+Option+F as one undo step, without saving", async () => {
  await press({ key: "Enter", keyCode: 13 });
  expect(await press({ key: "F", code: "KeyF", keyCode: 70, shiftKey: true, altKey: true }), "Shift+Option+F is the editor's").toBe(false);
  await waitFor(() => expect(shownText()).toBe("\nEXPORT CONST TOTAL = 1;\n"));
  expect(await screen.findByRole("tab", { name: "cart.ts, unsaved changes" })).toBeTruthy();
  expect(disk.writes).toEqual([]);
  await press({ key: "z", keyCode: 90, ctrlKey: true });
  expect(shownText()).toBe("\nexport const total = 1;\n");
});
