import "fake-indexeddb/auto";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Project, RpcMethod, RpcParams, RpcResults, ThreadSummary } from "@openorc/protocol";
import { fakeFileDisk, nthVersion } from "../fixtures/file-disk";
import { useDrafts } from "../lib/file-drafts";
import { useLayout, type FileSelection } from "../lib/layout";
import { usePanelSessions } from "../lib/panel-tabs";
import { invalidateTags, queryClient } from "../lib/query";
import { core } from "../lib/rpc";
import type { CodeEditorProps } from "./code-editor";
import { Panel } from "./Panel";

vi.mock("../lib/window", () => ({ useTrafficLights: () => false, useWindowsControls: () => false }));
vi.mock("./code-editor", async () => {
  const { useLayoutEffect, useRef, useState } = await import("react");
  const histories = new Map<string, string[]>();
  function historyOf(key: string): string[] {
    const history = histories.get(key) ?? [];
    histories.set(key, history);
    return history;
  }
  /** Keeps CodeEditor's contract: a `text` unlike its last report replaces the document as one undo step, every edit is reported at once, Ctrl+S saves. */
  function CodeEditor({ sessionKey, text, readOnly, onChange, onSave }: CodeEditorProps) {
    const history = historyOf(sessionKey);
    const [doc, setDoc] = useState(text);
    const shown = useRef(text);
    const reported = useRef(text);
    const show = (next: string) => {
      history.push(shown.current);
      shown.current = next;
      setDoc(next);
    };

    useLayoutEffect(() => {
      if (text === reported.current) return;
      reported.current = text;
      history.push(shown.current);
      shown.current = text;
      setDoc(text);
    }, [text, history]);

    const report = (next: string) => {
      reported.current = next;
      onChange(next);
    };

    return (
      <textarea
        aria-label="Editor"
        readOnly={readOnly}
        value={doc}
        onChange={(event) => {
          show(event.target.value);
          report(event.target.value);
        }}
        onKeyDown={(event) => {
          if (!event.ctrlKey) return;
          event.preventDefault();
          if (event.key === "s") onSave();
          const previous = event.key === "z" && !readOnly ? history.pop() : undefined;
          if (previous === undefined) return;
          shown.current = previous;
          setDoc(previous);
          report(previous);
        }}
      />
    );
  }
  return { CodeEditor, closeEditorSession: (key: string) => histories.delete(key) };
});

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

/** The agent, a terminal or another editor changing a file, followed by the push the core sends. */
function onDiskNow(path: string, text: string | null) {
  disk.set(path, text);
  act(() => invalidateTags(["workspace-diff"], { immediate: true }));
}

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
    if (method === "projects.git") return "none" as RpcResults[M];
    return [] as unknown as RpcResults[M];
  });
  usePanelSessions.setState({ sessions: {} });
  useLayout.setState({ panelOpen: true, panelTab: "file", panelRequest: null, panelThreadId: thread.id, selectedFile: null, selectedChanges: null, panelExpanded: false, previewUrls: {} });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openFile(selection: Partial<FileSelection> = {}) {
  usePanelSessions.getState().open(`thread:${thread.id}`, { kind: "file", selection: { path: "src/cart.ts", scope, ...selection } });
  render(
    <QueryClientProvider client={queryClient}>
      <Panel context={{ kind: "thread", thread, project }} />
    </QueryClientProvider>,
  );
}
const editor = () => screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Editor" });
const type = async (text: string) => fireEvent.change(await editor(), { target: { value: text } });
const press = async (key: string) => fireEvent.keyDown(await editor(), { key, ctrlKey: true });
const tab = (name: string) => screen.findByRole("tab", { name });

it("saves an edit with Cmd+S against the version it was typed on, and the tab's dot goes", async () => {
  await openFile();
  await type("export const total = 2;\n");
  await tab("cart.ts, unsaved changes");
  await press("s");
  await tab("cart.ts");
  expect(disk.writes).toEqual([{ scope, path: "src/cart.ts", text: "export const total = 2;\n", expected: { kind: "version", version: nthVersion(1) } }]);
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
});

it("takes a disk change into a buffer without edits", async () => {
  await openFile();
  await editor();
  onDiskNow("src/cart.ts", "export const total = 3;\n");
  await waitFor(async () => expect((await editor()).value).toBe("export const total = 3;\n"));
  expect(screen.queryByText("cart.ts changed after you started editing.")).toBeNull();
  expect(await tab("cart.ts")).toBeTruthy();
});

it("asks before a disk change meets unsaved edits, and Keep mine saves over it on purpose", async () => {
  await openFile();
  await type("mine\n");
  onDiskNow("src/cart.ts", "theirs\n");
  expect(await screen.findByText("cart.ts changed after you started editing.")).toBeTruthy();
  expect((await editor()).value).toBe("mine\n");
  expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
  await press("s");
  await tab("cart.ts");
  expect(disk.writes.at(-1)).toMatchObject({ text: "mine\n", expected: { kind: "version", version: nthVersion(2) } });
  expect(disk.files.get("src/cart.ts")?.text).toBe("mine\n");
});

it("takes the new version as one undo step, so Cmd+Z brings the edits back", async () => {
  await openFile();
  await type("mine\n");
  onDiskNow("src/cart.ts", "theirs\n");
  fireEvent.click(await screen.findByRole("button", { name: "Use new version" }));
  await waitFor(async () => expect((await editor()).value).toBe("theirs\n"));
  await tab("cart.ts");
  await press("z");
  expect((await editor()).value).toBe("mine\n");
  await tab("cart.ts, unsaved changes");
  expect(screen.queryByText("cart.ts changed after you started editing.")).toBeNull();
});

it("recreates a deleted file on Save, only if it is still absent", async () => {
  await openFile();
  await type("mine\n");
  onDiskNow("src/cart.ts", null);
  expect(await screen.findByText("cart.ts was deleted. Save to create it again.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(disk.files.get("src/cart.ts")?.text).toBe("mine\n"));
  expect(disk.writes.at(-1)?.expected).toEqual({ kind: "absent" });
});

it("opens a read-only file read-only, its reason one hover or focus away", async () => {
  disk.set("src/cart.ts", "export const total = 1;\n", "This pull request copy is read-only.");
  await openFile();
  expect((await editor()).readOnly).toBe(true);
  fireEvent.focus(screen.getByText("Read-only"));
  expect(await screen.findByText("This pull request copy is read-only.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
});

it("keeps unsaved edits through closing the panel", async () => {
  await openFile();
  await type("mine\n");
  fireEvent.click(screen.getByRole("button", { name: "Hide panel" }));
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Editor" })).toBeNull());
  act(() => useLayout.getState().setPanel(true));
  expect((await editor()).value).toBe("mine\n");
  expect(await tab("cart.ts, unsaved changes")).toBeTruthy();
});

it("says when unsaved edits can't be kept on this device", async () => {
  await openFile();
  await type("mine\n");
  act(() => useDrafts.setState({ failed: true }));
  expect(await screen.findByText("Unsaved changes can’t be kept on this device right now. Save to keep them.")).toBeTruthy();
});

it("closes a tab without unsaved edits at once", async () => {
  await openFile();
  await editor();
  fireEvent.click(screen.getByRole("button", { name: "Close cart.ts" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("tab", { name: "cart.ts" })).toBeNull();
});

it("asks before closing a tab with unsaved edits, and Cancel keeps it", async () => {
  await openFile();
  await type("mine\n");
  fireEvent.click(screen.getByRole("button", { name: "Close cart.ts" }));
  const dialog = await screen.findByRole("dialog", { name: "Save changes to cart.ts?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect((await editor()).value).toBe("mine\n");
});

it("drops the draft and the undo history when the user doesn't save", async () => {
  await openFile();
  await type("mine\n");
  await type("mine, more\n");
  fireEvent.click(screen.getByRole("button", { name: "Close cart.ts" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Don’t save" }));
  await waitFor(() => expect(screen.queryByRole("tab", { name: /cart\.ts/ })).toBeNull());
  act(() => usePanelSessions.getState().open(`thread:${thread.id}`, { kind: "file", selection: { path: "src/cart.ts", scope } }));
  expect((await editor()).value).toBe("export const total = 1;\n");
  await press("z");
  expect((await editor()).value).toBe("export const total = 1;\n");
  expect(await tab("cart.ts")).toBeTruthy();
});

it("saves and then closes when the user chooses Save", async () => {
  await openFile();
  await type("mine\n");
  fireEvent.click(screen.getByRole("button", { name: "Close cart.ts" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("tab", { name: /cart\.ts/ })).toBeNull());
  expect(disk.files.get("src/cart.ts")?.text).toBe("mine\n");
});

it("lets a file page expand to the full work row", async () => {
  await openFile();
  await editor();
  fireEvent.click(screen.getByRole("button", { name: "Expand panel" }));
  expect(useLayout.getState().panelExpanded).toBe(true);
  expect(document.querySelector("aside")?.hasAttribute("data-expanded")).toBe(true);
});

it("opens a cited line of a Markdown file in the editor and renders it on request", async () => {
  disk.set("docs/notes.md", "# Investigation\n\nSee [runs.ts](../packages/core/src/services/runs.ts)\n");
  await openFile({ path: "docs/notes.md", line: 3 });
  expect(await editor()).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "Preview" }));
  expect(await screen.findByRole("heading", { name: "Investigation" })).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Editor" })).toBeNull();
  fireEvent.click(screen.getByRole("link", { name: "runs.ts" }));
  expect(useLayout.getState().selectedFile).toMatchObject({ path: "/repo/packages/core/src/services/runs.ts", scope });
});

it("says why a file it can't edit isn't shown", async () => {
  await openFile({ path: "src/gone.ts" });
  expect(await screen.findByText("File not found. It may have moved or been deleted.")).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Editor" })).toBeNull();
});
