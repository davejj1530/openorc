import "fake-indexeddb/auto";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WORKSPACE_ID, type FindResult, type Project, type RpcMethod, type RpcParams, type RpcResults, type ThreadSummary } from "@openorc/protocol";
import { NewFileDialog } from "../dialogs/NewFileDialog";
import { fakeFileDisk } from "../fixtures/file-disk";
import { useAppShortcuts } from "../lib/app-shortcuts";
import { useDrafts } from "../lib/file-drafts";
import { useFilesTool } from "../lib/files-tool";
import { useLayout } from "../lib/layout";
import { usePanelSessions } from "../lib/panel-tabs";
import { queryClient } from "../lib/query";
import { core } from "../lib/rpc";
import { useRouter } from "../lib/router";
import type { CodeEditorProps } from "./code-editor";
import { Panel } from "./Panel";

vi.mock("../lib/window", () => ({ useTrafficLights: () => false, useWindowsControls: () => false }));
vi.mock("./code-editor", () => ({
  CodeEditor: ({ text, readOnly, onChange }: CodeEditorProps) => <textarea aria-label="Editor" readOnly={readOnly} value={text} onChange={(event) => onChange(event.target.value)} />,
  closeEditorSession: () => {},
}));

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
const searches: RpcParams<"files.search">[] = [];
const finds: RpcParams<"files.find">[] = [];

/** The core's find over the fake disk: lines holding the text in either case, grouped by file. */
function findOnDisk({ query }: RpcParams<"files.find">): FindResult {
  const groups = [...disk.files.entries()].flatMap(([path, file]) => {
    const lines = file.text.split("\n").flatMap((text, index) => (text.toLowerCase().includes(query.text.toLowerCase()) ? [{ line: index + 1, text }] : []));
    return lines.length ? [{ path, lines }] : [];
  });
  return { kind: "matches", groups, truncated: false };
}
let answerFind: (params: RpcParams<"files.find">) => FindResult | Promise<FindResult> = findOnDisk;

beforeEach(() => {
  disk = fakeFileDisk();
  disk.set("src/cart.ts", "export const total = 1;\n");
  disk.set("src/checkout.ts", "export {};\n");
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  useDrafts.setState({ keys: new Set(), ready: true, loaded: new Map(), failed: false });
  vi.stubGlobal("openorc", { browser: { setContext: vi.fn(), onReveal: () => () => {}, close: vi.fn(), navigate: vi.fn() } });
  vi.spyOn(core, "call").mockImplementation(async <M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> => {
    if (method === "files.search") {
      const search = params as RpcParams<"files.search">;
      searches.push(search);
      return [...disk.files.keys()].filter((path) => path.includes(search.query)) as RpcResults[M];
    }
    if (method === "files.read") return disk.read((params as RpcParams<"files.read">).path) as RpcResults[M];
    if (method === "files.write") return disk.write(params as RpcParams<"files.write">) as RpcResults[M];
    if (method === "files.find") {
      finds.push(params as RpcParams<"files.find">);
      return answerFind(params as RpcParams<"files.find">) as RpcResults[M];
    }
    return [] as unknown as RpcResults[M];
  });
  usePanelSessions.setState({ sessions: {} });
  useFilesTool.setState({ host: null, focus: null, tools: {} });
  useRouter.setState({ route: { view: "thread", threadId: thread.id }, threadIds: [thread.id] });
  useLayout.setState({ panelOpen: false, panelTab: "newtab", panelRequest: null, panelThreadId: thread.id, selectedFile: null, selectedChanges: null, panelExpanded: false, previewUrls: {} });
});
afterEach(() => {
  cleanup();
  searches.length = 0;
  finds.length = 0;
  answerFind = findOnDisk;
  queryClient.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Shortcuts() {
  useAppShortcuts(project.id);
  return null;
}

function Window() {
  useAppShortcuts(project.id);
  return (
    <QueryClientProvider client={queryClient}>
      <Panel context={{ kind: "thread", thread, project }} />
      <NewFileDialog />
    </QueryClientProvider>
  );
}

const press = (key: string) => fireEvent.keyDown(document.body, { key, metaKey: true });
const pressShift = (key: string) => fireEvent.keyDown(document.body, { key, metaKey: true, shiftKey: true });
const findBox = () => screen.findByRole<HTMLInputElement>("textbox", { name: "Find in files" });
const search = () => screen.findByRole<HTMLInputElement>("textbox", { name: "Find a file" });
const tabs = () => screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label"));
const activeTab = () =>
  screen
    .getAllByRole("tab")
    .find((tab) => tab.getAttribute("aria-selected") === "true")
    ?.getAttribute("aria-label");
const editor = () => screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Editor" });

it("opens the Files tool on ⌘P in the panel's new tab, focused, and Enter opens the first file in a tab of its own", async () => {
  render(<Window />);
  expect(press("p"), "the window claims ⌘P").toBe(false);
  const box = await search();
  expect(useLayout.getState().panelOpen).toBe(true);
  expect(tabs()).toEqual(["Files"]);
  await waitFor(() => expect(document.activeElement).toBe(box));
  fireEvent.change(box, { target: { value: "cart" } });
  await screen.findByRole("button", { name: "src/cart.ts" });
  expect(searches.at(-1)).toEqual({ scope, query: "cart", limit: 50 });
  fireEvent.keyDown(box, { key: "Enter" });
  expect((await editor()).value).toBe("export const total = 1;\n");
  expect(tabs()).toEqual(["Files", "cart.ts"]);
  expect(activeTab()).toBe("cart.ts");
});

it("leaves the Enter that ends an input method's composition to the search box", async () => {
  render(<Window />);
  press("p");
  const box = await search();
  fireEvent.change(box, { target: { value: "cart" } });
  await screen.findByRole("button", { name: "src/cart.ts" });
  fireEvent.keyDown(box, { key: "Enter", isComposing: true });
  expect(tabs()).toEqual(["Files"]);
});

it("brings a second ⌘P back to the same Files tab, with what was typed selected", async () => {
  render(<Window />);
  press("p");
  fireEvent.change(await search(), { target: { value: "cart" } });
  fireEvent.click(await screen.findByRole("button", { name: "src/cart.ts" }));
  await editor();
  press("p");
  const box = await search();
  expect(tabs()).toEqual(["Files", "cart.ts"]);
  expect(activeTab()).toBe("Files");
  expect(box.value).toBe("cart");
  await waitFor(() => expect(document.activeElement).toBe(box));
  expect([box.selectionStart, box.selectionEnd]).toEqual([0, 4]);
});

it("takes focus back to the search box on ⌘P while the Files tool already shows", async () => {
  render(<Window />);
  press("p");
  const box = await search();
  fireEvent.change(box, { target: { value: "check" } });
  screen.getByRole("tab", { name: "Files" }).focus();
  press("p");
  await waitFor(() => expect(document.activeElement).toBe(box));
  expect([box.selectionStart, box.selectionEnd]).toEqual([0, 5]);
});

it("opens the Files tool on ⌘P rather than the file a link opened before", async () => {
  render(<Window />);
  act(() => useLayout.getState().openFile({ path: "src/cart.ts", scope }));
  await editor();
  press("p");
  expect(await search()).toBeTruthy();
  expect(tabs()).toEqual(["cart.ts", "Files"]);
});

it("moves between the files found with the arrow keys and opens the one chosen", async () => {
  render(<Window />);
  press("p");
  const box = await search();
  fireEvent.change(box, { target: { value: "src" } });
  await screen.findByRole("button", { name: "src/checkout.ts" });
  fireEvent.keyDown(box, { key: "ArrowDown" });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "src/cart.ts" }));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "src/checkout.ts" }));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
  fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
  expect(document.activeElement, "up from the first file returns to the search box").toBe(box);
  fireEvent.keyDown(box, { key: "ArrowDown" });
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  fireEvent.click(document.activeElement!);
  expect((await editor()).value).toBe("export {};\n");
});

it("creates a file from the Files tool's New file and opens it empty in a tab", async () => {
  render(<Window />);
  press("p");
  await search();
  fireEvent.click(screen.getByRole("button", { name: "New file" }));
  const path = await screen.findByRole("textbox", { name: "Path" });
  fireEvent.change(path, { target: { value: "src/new.ts" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  expect((await editor()).value).toBe("");
  expect(activeTab()).toBe("new.ts");
  expect(disk.writes).toEqual([{ scope, path: "src/new.ts", text: "", expected: { kind: "absent" } }]);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("finds what files contain on ⌘⇧F, grouped by file, and opens a line's file there in a tab of its own", async () => {
  disk.set("src/cart.ts", "export const total = 1;\nexport const totalWithTax = 2;\n");
  render(<Window />);
  expect(pressShift("F"), "the window claims ⌘⇧F").toBe(false);
  const box = await findBox();
  await waitFor(() => expect(document.activeElement).toBe(box));
  expect(screen.getByRole("radio", { name: "Contents" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.change(box, { target: { value: "total" } });
  expect(await screen.findByText("2 matching lines in 1 file.")).toBeTruthy();
  expect(finds).toEqual([{ scope, query: { text: "total", regex: false, caseSensitive: false } }]);
  const file = screen.getByRole("link", { name: /cart\.ts$/ }).closest("section")!;
  expect([...within(file).getAllByRole("listitem")].map((line) => line.textContent)).toEqual(["1export const total = 1;", "2export const totalWithTax = 2;"]);
  expect([...file.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual(["total", "total"]);
  fireEvent.click(within(file).getByRole("link", { name: "2" }));
  expect(await screen.findByText("cart.ts:2")).toBeTruthy();
  expect(tabs()).toEqual(["Files", "cart.ts"]);
  fireEvent.click(screen.getByRole("tab", { name: "Files" }));
  expect(await screen.findByText("2 matching lines in 1 file.")).toBeTruthy();
  expect((await findBox()).value).toBe("total");
});

it("sends Match case and Regex with the text, and shows why a pattern can't be read", async () => {
  answerFind = () => ({ kind: "invalid", message: "Invalid regular expression: parentheses not balanced" });
  render(<Window />);
  pressShift("F");
  const box = await findBox();
  fireEvent.click(screen.getByRole("button", { name: "Match case" }));
  fireEvent.click(screen.getByRole("button", { name: "Regex" }));
  fireEvent.change(box, { target: { value: "total(" } });
  expect((await screen.findByRole("alert")).textContent).toBe("Invalid regular expression: parentheses not balanced");
  expect(finds.at(-1)?.query).toEqual({ text: "total(", regex: true, caseSensitive: true });
  expect(screen.getByRole("button", { name: "Regex" }).getAttribute("aria-pressed")).toBe("true");
});

it("opens a found file whose name a link would read as an address", async () => {
  disk.set("a:b.ts", "const total = 3;\n");
  render(<Window />);
  pressShift("F");
  fireEvent.change(await findBox(), { target: { value: "total = 3" } });
  const file = (await screen.findByRole("link", { name: /a:b\.ts$/ })).closest("section")!;
  fireEvent.click(within(file).getByRole("link", { name: "1" }));
  expect(await screen.findByText("a:b.ts:1")).toBeTruthy();
});

it("switches between finding by name and by contents, each keeping what was typed", async () => {
  render(<Window />);
  press("p");
  fireEvent.change(await search(), { target: { value: "cart" } });
  fireEvent.click(screen.getByRole("radio", { name: "Contents" }));
  const box = await findBox();
  await waitFor(() => expect(document.activeElement).toBe(box));
  fireEvent.change(box, { target: { value: "total" } });
  fireEvent.click(screen.getByRole("radio", { name: "File names" }));
  expect((await search()).value).toBe("cart");
  pressShift("F");
  expect((await findBox()).value).toBe("total");
  expect(tabs()).toEqual(["Files"]);
});

it("starts one find once typing pauses, not one per keystroke", async () => {
  render(<Window />);
  pressShift("F");
  const box = await findBox();
  for (const typed of ["t", "to", "tot", "tota", "total"]) fireEvent.change(box, { target: { value: typed } });
  expect(await screen.findByText("1 matching line in 1 file.")).toBeTruthy();
  expect(finds.map((find) => find.query.text)).toEqual(["total"]);
});

it("shows nothing for a find that a newer one stopped", async () => {
  answerFind = () => ({ kind: "superseded" });
  render(<Window />);
  pressShift("F");
  fireEvent.change(await findBox(), { target: { value: "total" } });
  await waitFor(() => expect(finds).toHaveLength(1));
  await waitFor(() => expect(screen.queryByText("Searching…")).toBeNull());
  expect(screen.queryByText(/match/)).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("marks a file's tab with the kind of file it holds, and the Files tool's tab with its own mark", async () => {
  disk.set("notes.md", "# Shop\n");
  render(<Window />);
  press("p");
  await search();
  act(() => useLayout.getState().openFile({ path: "src/cart.ts", scope }));
  await editor();
  act(() => useLayout.getState().openFile({ path: "notes.md", scope, line: 1 }));
  await screen.findByRole("tab", { name: "notes.md" });
  const mark = (name: string) => screen.getByRole("tab", { name }).querySelector("svg")?.getAttribute("data-icon");
  expect([mark("Files"), mark("cart.ts"), mark("notes.md")]).toEqual(["Folder", "FileCode2", "FileText"]);
});

it("keeps the last lines unmarked under Searching… while the next find runs", async () => {
  render(<Window />);
  pressShift("F");
  const box = await findBox();
  fireEvent.change(box, { target: { value: "total" } });
  expect(await screen.findByText("1 matching line in 1 file.")).toBeTruthy();
  let finish: (result: FindResult) => void = () => {};
  answerFind = () => new Promise((resolve) => (finish = resolve));
  fireEvent.click(screen.getByRole("button", { name: "Regex" }));
  expect(await screen.findByText("Searching…")).toBeTruthy();
  expect(screen.getByText("export const total = 1;")).toBeTruthy();
  expect(document.querySelectorAll("mark")).toHaveLength(0);
  act(() => finish({ kind: "matches", truncated: false, groups: [] }));
  expect(await screen.findByText("No matches.")).toBeTruthy();
});

it("doesn't search for spaces alone", async () => {
  render(<Window />);
  pressShift("F");
  fireEvent.change(await findBox(), { target: { value: "   " } });
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(finds).toEqual([]);
});

it("leaves focus where it was when the panel shows the Files tool without being asked", async () => {
  usePanelSessions.getState().open(`thread:${thread.id}`, { kind: "file", selection: null });
  useLayout.setState({ panelOpen: true });
  render(<Window />);
  const box = await search();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(document.activeElement).not.toBe(box);
});

it("focuses the search box when the Files tool is opened from the new tab's tools", async () => {
  useLayout.setState({ panelOpen: true });
  render(<Window />);
  fireEvent.click(await screen.findByRole("button", { name: "Files" }));
  const box = await search();
  await waitFor(() => expect(document.activeElement).toBe(box));
});

it("brings ⌘P to a tab already showing the Files tool before filling the new tab", async () => {
  const panel = `thread:${thread.id}`;
  usePanelSessions.getState().open(panel, { kind: "file", selection: null });
  usePanelSessions.getState().add(panel);
  render(<Window />);
  press("p");
  const box = await search();
  expect(tabs()).toEqual(["Files", "New tab"]);
  expect(activeTab()).toBe("Files");
  await waitFor(() => expect(document.activeElement).toBe(box));
});

it("searches a git project's checkout from a new thread's panel, and a Workspace thread's chosen folder", async () => {
  useRouter.setState({ route: { view: "newthread", projectId: project.id } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Shortcuts />
      <Panel context={{ kind: "newthread", project, workingDirectory: project.rootPath, changes: true }} />
    </QueryClientProvider>,
  );
  press("p");
  await search();
  await waitFor(() => expect(searches.at(-1)?.scope).toEqual({ kind: "project", id: project.id }));
  view.unmount();
  const workspace = { ...project, id: WORKSPACE_ID, name: "Workspace", rootPath: "/home" };
  render(
    <QueryClientProvider client={queryClient}>
      <Shortcuts />
      <Panel context={{ kind: "newthread", project: workspace, workingDirectory: "/notes", changes: false }} />
    </QueryClientProvider>,
  );
  press("p");
  await waitFor(() => expect(searches.at(-1)?.scope).toEqual({ kind: "project", id: WORKSPACE_ID, workingDirectory: "/notes" }));
});
