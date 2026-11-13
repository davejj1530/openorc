import "fake-indexeddb/auto";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileVersion, FolderPath, WORKSPACE_ID, type FileRead, type FindResult, type Project, type RpcMethod, type RpcParams, type RpcResults, type ThreadSummary } from "@openorc/protocol";
import { NewFileDialog } from "../dialogs/NewFileDialog";
import { fakeFileDisk } from "../fixtures/file-disk";
import { useAppShortcuts } from "../lib/app-shortcuts";
import { useDrafts } from "../lib/file-drafts";
import { useFilesTool } from "../lib/files-tool";
import { useFileExplorer } from "../lib/file-explorer";
import { useWordWrap } from "../lib/word-wrap";
import { useLayout } from "../lib/layout";
import { usePanelSessions } from "../lib/panel-tabs";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { useRouter } from "../lib/router";
import type { CodeEditorProps } from "./code-editor";
import { Panel } from "./Panel";

vi.mock("../lib/window", () => ({ useTrafficLights: () => false, useWindowsControls: () => false }));
vi.mock("./code-editor", () => ({
  CodeEditor: ({ text, readOnly, lineWrapping, onChange }: CodeEditorProps) => (
    <textarea aria-label="Editor" data-wrap={lineWrapping} readOnly={readOnly} value={text} onChange={(event) => onChange(event.target.value)} />
  ),
  CodeExcerpt: ({ start, end }: { start: number; end: number }) => <pre>{`lines ${start}-${end}`}</pre>,
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
const explains: RpcParams<"code.explain">[] = [];

/** The core's find over the fake disk: lines holding the text in either case, grouped by file. */
function findOnDisk({ query }: RpcParams<"files.find">): FindResult {
  const groups = [...disk.files.entries()].flatMap(([path, file]) => {
    const lines = file.text.split("\n").flatMap((text, index) => (text.toLowerCase().includes(query.text.toLowerCase()) ? [{ line: index + 1, text }] : []));
    return lines.length ? [{ path, lines }] : [];
  });
  return { kind: "matches", groups, truncated: false };
}
let answerFind: (params: RpcParams<"files.find">) => FindResult | Promise<FindResult> = findOnDisk;
let answerSearch: ((params: RpcParams<"files.search">) => string[]) | null = null;

beforeEach(() => {
  disk = fakeFileDisk();
  disk.set("src/cart.ts", "export const total = 1;\n");
  disk.set("src/checkout.ts", "export {};\n");
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  useDrafts.setState({ keys: new Set(), ready: true, loaded: new Map(), failed: false });
  vi.stubGlobal("openorc", { browser: { setContext: vi.fn(), onReveal: () => () => {}, close: vi.fn(), navigate: vi.fn() } });
  vi.spyOn(core, "call").mockImplementation(async <M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> => {
    if (method === "files.list") return disk.list((params as RpcParams<"files.list">).path) as RpcResults[M];
    if (method === "files.search") {
      const search = params as RpcParams<"files.search">;
      searches.push(search);
      return (answerSearch?.(search) ?? [...disk.files.keys()].filter((path) => path.includes(search.query))) as RpcResults[M];
    }
    if (method === "files.read") return disk.read((params as RpcParams<"files.read">).path) as RpcResults[M];
    if (method === "files.write") return disk.write(params as RpcParams<"files.write">) as RpcResults[M];
    if (method === "files.find") {
      finds.push(params as RpcParams<"files.find">);
      return answerFind(params as RpcParams<"files.find">) as RpcResults[M];
    }
    if (method === "code.explain") {
      explains.push(params as RpcParams<"code.explain">);
      const notes = [{ lines: { start: 1, end: 1 }, text: "Holds the cart's total." }];
      return { kind: "explained", explanation: { view: "english", notes }, model: { provider: "claude", label: "Claude Haiku 4.5" }, createdAt: 1 } as RpcResults[M];
    }
    return [] as unknown as RpcResults[M];
  });
  usePanelSessions.setState({ sessions: {} });
  useFilesTool.setState({ host: null, focus: null, tools: {} });
  useFileExplorer.setState({ visible: true, width: 240, folders: {} });
  useRouter.setState({ route: { view: "thread", threadId: thread.id }, threadIds: [thread.id] });
  useLayout.setState({ panelOpen: false, panelTab: "newtab", panelRequest: null, panelThreadId: thread.id, selectedFile: null, selectedChanges: null, panelExpanded: false, previewUrls: {} });
});
afterEach(() => {
  cleanup();
  searches.length = 0;
  finds.length = 0;
  explains.length = 0;
  answerFind = findOnDisk;
  answerSearch = null;
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
const search = () => screen.findByRole<HTMLInputElement>("textbox", { name: "Search files" });
const inFiles = () => screen.findByRole("region", { name: "In files" });
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
  await waitFor(() => expect(activeTab()).toBe("Files"));
  const box = await search();
  expect(tabs()).toEqual(["Files", "cart.ts"]);
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

it("finds what files contain from the same search box on ⌘⇧F, grouped by file, and opens a line's file there in a tab of its own", async () => {
  disk.set("src/cart.ts", "export const total = 1;\nexport const totalWithTax = 2;\n");
  render(<Window />);
  expect(pressShift("F"), "the window claims ⌘⇧F").toBe(false);
  const box = await search();
  await waitFor(() => expect(document.activeElement).toBe(box));
  fireEvent.change(box, { target: { value: "total" } });
  const lines = await inFiles();
  expect(await within(lines).findByText("2 lines")).toBeTruthy();
  expect(finds).toEqual([{ scope, query: { text: "total", regex: false, caseSensitive: false } }]);
  const file = within(lines)
    .getByRole("link", { name: /cart\.ts$/ })
    .closest("section")!;
  expect([...within(file).getAllByRole("listitem")].map((line) => line.textContent)).toEqual(["1export const total = 1;", "2export const totalWithTax = 2;"]);
  expect([...file.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual(["total", "total"]);
  fireEvent.click(within(file).getByRole("link", { name: "2" }));
  expect(await screen.findByText("cart.ts:2")).toBeTruthy();
  expect(tabs()).toEqual(["Files", "cart.ts"]);
  fireEvent.click(screen.getByRole("tab", { name: "Files" }));
  expect(await within(await inFiles()).findByText("2 lines")).toBeTruthy();
  expect((await search()).value).toBe("total");
});

it("sends Match case and Regex with the text, and shows why a pattern can't be read", async () => {
  answerFind = () => ({ kind: "invalid", message: "Invalid regular expression: parentheses not balanced" });
  render(<Window />);
  pressShift("F");
  fireEvent.change(await search(), { target: { value: "total(" } });
  const lines = await inFiles();
  fireEvent.click(within(lines).getByRole("button", { name: "Match case" }));
  fireEvent.click(within(lines).getByRole("button", { name: "Regex" }));
  await waitFor(() => expect(finds.at(-1)?.query).toEqual({ text: "total(", regex: true, caseSensitive: true }));
  expect((await screen.findByRole("alert")).textContent).toBe("Invalid regular expression: parentheses not balanced");
  expect(screen.getByRole("button", { name: "Regex" }).getAttribute("aria-pressed")).toBe("true");
});

it("opens a found file whose name a link would read as an address", async () => {
  disk.set("a:b.ts", "const total = 3;\n");
  render(<Window />);
  pressShift("F");
  fireEvent.change(await search(), { target: { value: "total = 3" } });
  const file = (await screen.findByRole("link", { name: /a:b\.ts$/ })).closest("section")!;
  fireEvent.click(within(file).getByRole("link", { name: "1" }));
  expect(await screen.findByText("a:b.ts:1")).toBeTruthy();
});

it("narrows the tree in place: matches in open folders stay in them, the rest of the project's below, the letters matched marked", async () => {
  disk.set("docs/cart-notes.md", "# Cart\n");
  useLayout.setState({ panelOpen: true });
  render(<Window />);
  fireEvent.click(screen.getByRole("button", { name: "Files" }));
  fireEvent.click(await screen.findByRole("treeitem", { name: "src" }));
  await screen.findByRole("treeitem", { name: "cart.ts" });
  fireEvent.change(await search(), { target: { value: "cart" } });
  const tree = await screen.findByRole("group", { name: "In open folders" });
  const match = await within(tree).findByRole("button", { name: "src/cart.ts" });
  expect(match.querySelector(".file-search-hit")?.textContent).toBe("cart");
  expect(within(tree).queryByRole("button", { name: "src/checkout.ts" })).toBeNull();
  const elsewhere = screen.getByRole("region", { name: "More in the project" });
  expect(
    within(elsewhere)
      .getAllByRole("button")
      .map((row) => row.getAttribute("aria-label")),
  ).toEqual(["docs/cart-notes.md"]);
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Search files" }), { key: "Escape" });
  expect(await screen.findByRole("treeitem", { name: "checkout.ts" })).toBeTruthy();
});

it("keeps one search for the conversation, on ⌘P and ⌘⇧F alike", async () => {
  render(<Window />);
  press("p");
  fireEvent.change(await search(), { target: { value: "cart" } });
  pressShift("F");
  expect((await search()).value).toBe("cart");
  expect(tabs()).toEqual(["Files"]);
});

it("shows the lines of the first few files, then the rest on asking", async () => {
  for (const name of ["a", "b", "c", "d", "e", "f"]) disk.set(`lib/${name}.ts`, "export const total = 0;\n");
  render(<Window />);
  press("p");
  fireEvent.change(await search(), { target: { value: "total" } });
  const lines = await inFiles();
  await within(lines).findByText("7 lines");
  expect(lines.querySelectorAll(".tool-view-matches > section")).toHaveLength(6);
  fireEvent.click(within(lines).getByRole("button", { name: "Show all 7 matches" }));
  expect(lines.querySelectorAll(".tool-view-matches > section")).toHaveLength(7);
});

it("searches inside files once three letters are typed, or fewer with Regex or Match case on", async () => {
  render(<Window />);
  press("p");
  fireEvent.change(await search(), { target: { value: "to" } });
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(finds).toEqual([]);
  fireEvent.click(within(await inFiles()).getByRole("button", { name: "Match case" }));
  await waitFor(() => expect(finds.map((find) => find.query)).toEqual([{ text: "to", regex: false, caseSensitive: true }]));
});

it("opens the name the core ranked best on Enter, wherever it is drawn", async () => {
  disk.set("src/total.ts", "export {};\n");
  disk.set("total.md", "# Total\n");
  useLayout.setState({ panelOpen: true });
  render(<Window />);
  fireEvent.click(screen.getByRole("button", { name: "Files" }));
  fireEvent.click(await screen.findByRole("treeitem", { name: "src" }));
  await screen.findByRole("treeitem", { name: "total.ts" });
  answerSearch = () => ["total.md", "src/total.ts"];
  const box = await search();
  fireEvent.change(box, { target: { value: "total" } });
  await screen.findByRole("button", { name: "total.md" });
  fireEvent.keyDown(box, { key: "Enter" });
  expect(await screen.findByRole("tab", { name: "total.md" })).toBeTruthy();
});

it("starts one find once typing pauses, not one per keystroke", async () => {
  render(<Window />);
  pressShift("F");
  const box = await search();
  for (const typed of ["t", "to", "tot", "tota", "total"]) fireEvent.change(box, { target: { value: typed } });
  expect(await within(await inFiles()).findByText("1 line")).toBeTruthy();
  expect(finds.map((find) => find.query.text)).toEqual(["total"]);
});

it("shows nothing for a find that a newer one stopped", async () => {
  answerFind = () => ({ kind: "superseded" });
  render(<Window />);
  pressShift("F");
  fireEvent.change(await search(), { target: { value: "total" } });
  await waitFor(() => expect(finds).toHaveLength(1));
  const lines = await inFiles();
  await waitFor(() => expect(within(lines).queryByText("Searching…")).toBeNull());
  expect(within(lines).queryAllByRole("listitem")).toHaveLength(0);
  expect(within(lines).queryByText("No lines match.")).toBeNull();
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
  fireEvent.change(await search(), { target: { value: "total" } });
  const lines = await inFiles();
  expect(await within(lines).findByText("1 line")).toBeTruthy();
  let finish: (result: FindResult) => void = () => {};
  answerFind = () => new Promise((resolve) => (finish = resolve));
  fireEvent.click(within(lines).getByRole("button", { name: "Regex" }));
  expect(await within(lines).findByText("Searching…")).toBeTruthy();
  expect(within(lines).getByText("export const total = 1;")).toBeTruthy();
  expect(lines.querySelectorAll("mark")).toHaveLength(0);
  act(() => finish({ kind: "matches", truncated: false, groups: [] }));
  expect(await within(lines).findByText("No lines match.")).toBeTruthy();
});

it("doesn't search for spaces alone", async () => {
  render(<Window />);
  pressShift("F");
  fireEvent.change(await search(), { target: { value: "   " } });
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(finds).toEqual([]);
  expect(searches).toEqual([]);
  expect(screen.getByRole("tree", { name: "Project files" })).toBeTruthy();
});

it("leaves focus where it was when the panel shows the Files tool without being asked", async () => {
  usePanelSessions.getState().open(`thread:${thread.id}`, { kind: "file", selection: null });
  useLayout.setState({ panelOpen: true });
  render(<Window />);
  const box = await screen.findByRole("textbox", { name: "Search files" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(document.activeElement).not.toBe(box);
});

it("focuses the search box when the Files tool is opened from the new tab's tools", async () => {
  useLayout.setState({ panelOpen: true });
  render(<Window />);
  fireEvent.click(await screen.findByRole("button", { name: "Files" }));
  const box = await screen.findByRole("textbox", { name: "Search files" });
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
  fireEvent.change(await search(), { target: { value: "cart" } });
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
  fireEvent.change(await search(), { target: { value: "cart" } });
  await waitFor(() => expect(searches.at(-1)?.scope).toEqual({ kind: "project", id: WORKSPACE_ID, workingDirectory: "/notes" }));
});

it("starts with a folder tree and keeps it beside file tabs without browser controls or losing edits", async () => {
  useLayout.setState({ panelOpen: true });
  render(<Window />);
  fireEvent.click(screen.getByRole("button", { name: "Files" }));
  const src = await screen.findByRole("treeitem", { name: "src" });
  expect(src.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("textbox", { name: "Preview address" })).toBeNull();
  fireEvent.click(src);
  fireEvent.click(await screen.findByRole("treeitem", { name: "cart.ts" }));
  const first = await editor();
  fireEvent.change(first, { target: { value: "export const total = 42;\n" } });
  expect(screen.getByRole("navigation", { name: "File path" }).textContent).toBe("reposrccart.ts");
  expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
  fireEvent.click(await screen.findByRole("treeitem", { name: "checkout.ts" }));
  await waitFor(() => expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Editor" }).value).toBe("export {};\n"));
  expect(screen.getByRole("treeitem", { name: "src" }).getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(screen.getByRole("tab", { name: "cart.ts, unsaved changes" }));
  await waitFor(() => expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Editor" }).value).toBe("export const total = 42;\n"));
  fireEvent.click(screen.getByRole("button", { name: "File actions" }));
  expect(await screen.findByRole("menuitem", { name: "Refresh" })).toBeTruthy();
  expect(screen.getByRole("menuitem", { name: "Copy path" })).toBeTruthy();
});

it("shows a file a reply links outside the folder read-only, under its own folder, without touching the tree", async () => {
  const linked = "/tmp/vault/signin.log";
  const outside: FileRead = {
    kind: "file",
    root: "/private/tmp/vault",
    path: FolderPath.parse("signin.log"),
    outside: true,
    absolutePath: "/private/tmp/vault/signin.log",
    version: FileVersion.parse("a".repeat(64)),
    text: "signed in\n",
    readOnly: "This file is outside this conversation's folder.",
  };
  const answer = vi.mocked(core.call).getMockImplementation();
  vi.mocked(core.call).mockImplementation(async (method, params) => (method === "files.read" && (params as RpcParams<"files.read">).path === linked ? outside : answer?.(method, params)) as never);
  useLayout.setState({ panelOpen: true });
  render(<Window />);
  act(() => useLayout.getState().openFile({ path: linked, scope }));
  const shown = await editor();
  expect([shown.value, shown.readOnly]).toEqual(["signed in\n", true]);
  const crumbs = screen.getByRole("navigation", { name: "File path" });
  expect(crumbs.textContent).toBe("vaultsignin.log");
  expect(within(crumbs).queryByRole("button")).toBeNull();
  expect(screen.getByText("Read-only")).toBeTruthy();
  await screen.findByRole("treeitem", { name: "src" });
  expect(Object.values(useFileExplorer.getState().folders).flat()).not.toContainEqual(expect.stringContaining("tmp"));
});

it("offers a code file's views in its menu, not on screen, and explains it once one is chosen", async () => {
  disk.set("README.md", "# Shop\n");
  useLayout.setState({ panelOpen: true });
  render(<Window />);
  fireEvent.click(screen.getByRole("button", { name: "Files" }));
  fireEvent.click(await screen.findByRole("treeitem", { name: "src" }));
  fireEvent.click(await screen.findByRole("treeitem", { name: "cart.ts" }));
  await editor();
  expect(screen.queryByRole("radiogroup", { name: "File view" })).toBeNull();
  const views = async () => {
    fireEvent.click(screen.getByRole("button", { name: "File actions" }));
    return within(await screen.findByRole("group", { name: "File view" }));
  };
  const menu = await views();
  expect(menu.getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["Code", "Plain English", "Walkthrough", "Diagram"]);
  expect(menu.getByRole("menuitemradio", { name: "Code" }).getAttribute("aria-checked")).toBe("true");
  expect(explains).toEqual([]);
  fireEvent.click(menu.getByRole("menuitemradio", { name: "Plain English" }));
  expect(await screen.findByText("Holds the cart's total.")).toBeTruthy();
  expect(explains).toEqual([{ scope, path: "src/cart.ts", view: "english", text: "export const total = 1;\n" }]);
  expect(screen.queryByRole("textbox", { name: "Editor" })).toBeNull();
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  fireEvent.click((await views()).getByRole("menuitemradio", { name: "Code" }));
  expect(await editor()).toBeTruthy();

  fireEvent.click(await screen.findByRole("treeitem", { name: "README.md" }));
  await waitFor(() =>
    expect(
      within(screen.getByRole("radiogroup", { name: "File view" }))
        .getAllByRole("radio")
        .map((radio) => radio.textContent),
    ).toEqual(["Preview", "Source"]),
  );
});

it("wraps code by default and turns it off from the file's Word wrap, for every file after", async () => {
  useWordWrap.setState({ wrap: true });
  useLayout.setState({ panelOpen: true });
  render(<Window />);
  fireEvent.click(screen.getByRole("button", { name: "Files" }));
  fireEvent.click(await screen.findByRole("treeitem", { name: "src" }));
  fireEvent.click(await screen.findByRole("treeitem", { name: "cart.ts" }));
  expect((await editor()).dataset.wrap).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "File actions" }));
  const item = await screen.findByRole("menuitemcheckbox", { name: "Word wrap" });
  expect(item.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(item);
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Editor" }).dataset.wrap).toBe("false"));
  expect(localStorage.getItem("openorc.word-wrap")).toBe("off");
  fireEvent.click(await screen.findByRole("treeitem", { name: "checkout.ts" }));
  await waitFor(() => expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Editor" }).value).toBe("export {};\n"));
  expect(screen.getByRole("textbox", { name: "Editor" }).dataset.wrap).toBe("false");
});

it("navigates and collapses directories with the keyboard, then opens the selected file", async () => {
  useLayout.setState({ panelOpen: true });
  render(<Window />);
  fireEvent.click(screen.getByRole("button", { name: "Files" }));
  const src = await screen.findByRole("treeitem", { name: "src" });
  act(() => src.focus());
  fireEvent.keyDown(src, { key: "ArrowRight" });
  const cart = await screen.findByRole("treeitem", { name: "cart.ts" });
  fireEvent.keyDown(src, { key: "ArrowRight" });
  expect(document.activeElement).toBe(cart);
  fireEvent.keyDown(cart, { key: "ArrowLeft" });
  expect(document.activeElement).toBe(src);
  fireEvent.keyDown(src, { key: "ArrowLeft" });
  expect(screen.queryByRole("treeitem", { name: "cart.ts" })).toBeNull();
  fireEvent.keyDown(src, { key: "ArrowRight" });
  await screen.findByRole("treeitem", { name: "cart.ts" });
  fireEvent.keyDown(src, { key: "End" });
  expect(document.activeElement).toBe(screen.getByRole("treeitem", { name: "checkout.ts" }));
  fireEvent.keyDown(document.activeElement!, { key: "Enter" });
  expect((await editor()).value).toBe("export {};\n");
});

it("remembers the tree width and visibility, refreshes directory entries, and filters files", async () => {
  render(<Window />);
  act(() => useLayout.getState().openFile({ path: "src/cart.ts", scope }));
  await editor();
  const separator = screen.getByRole("separator", { name: "Resize file explorer" });
  fireEvent.keyDown(separator, { key: "ArrowLeft" });
  expect(separator.getAttribute("aria-valuenow")).toBe("256");
  fireEvent.click(screen.getByRole("button", { name: "Hide file explorer" }));
  expect(screen.queryByRole("tree")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show file explorer" }));
  expect(screen.getByRole("separator", { name: "Resize file explorer" }).getAttribute("aria-valuenow")).toBe("256");
  disk.set("notes.md", "# Notes\n");
  fireEvent.click(screen.getByRole("button", { name: "Refresh files" }));
  expect(await screen.findByRole("treeitem", { name: "notes.md" })).toBeTruthy();
  const filter = screen.getByRole("textbox", { name: "Search files" });
  fireEvent.change(filter, { target: { value: "checkout" } });
  expect(await within(await screen.findByRole("group", { name: "In open folders" })).findByRole("button", { name: "src/checkout.ts" })).toBeTruthy();
  fireEvent.keyDown(filter, { key: "Escape" });
  expect(await screen.findByRole("treeitem", { name: "cart.ts" })).toBeTruthy();
});

it("shows ignored entries dimmed, beside the rest", async () => {
  for (const path of ["node_modules/library/index.js", "output/result.txt", ".env", ".github/workflows/ci.yml"]) disk.set(path, "fixture\n");
  for (const path of ["node_modules", "output", ".env"]) disk.ignored.add(path);
  render(<Window />);
  act(() => useLayout.getState().openFile({ path: "src/cart.ts", scope }));
  await editor();
  const row = async (name: string) => (await screen.findByRole("treeitem", { name })).querySelector(".file-tree-row")!;
  for (const name of disk.ignored) expect((await row(name)).classList.contains("file-tree-ignored")).toBe(true);
  expect((await row(".github")).classList.contains("file-tree-ignored")).toBe(false);
  fireEvent.click(await screen.findByRole("treeitem", { name: ".env" }));
  expect(await screen.findByRole("treeitem", { name: ".env", selected: true })).toBeTruthy();
});
