// @vitest-environment jsdom
import type { FileRead, RpcMethod } from "@openorc/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { LinkState } from "../connection/manager";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { nativeProps } from "../test-fixtures/react-native";
import { FileScreen } from "./FileScreen";
import { FilesScreen } from "./FilesScreen";

const studio = { id: "mac-1", name: "Studio" };
const connected: LinkState = { kind: "connected", mac: studio, route: { kind: "lan", host: "studio.local", port: 1 }, serial: 1 };
const asleep: LinkState = { kind: "waiting", mac: studio, why: "silent", retryAt: null };
const entry = (path: string, kind: "directory" | "file", ignored = false) => ({ name: path.split("/").at(-1)!, path, kind, ignored });
const LISTINGS: Record<string, unknown> = {
  "": { root: "", name: "web", entries: [entry("src", "directory"), entry("node_modules", "directory", true), entry("board.png", "file"), entry("README.md", "file")] },
  src: { root: "", name: "web", entries: [entry("src/plans", "directory")] },
  "src/plans": { root: "", name: "web", entries: [] },
  never: { root: "", name: "web", entries: [], unavailable: { message: "This thread hasn't saved its work yet.", retry: false } },
  offline: { root: "", name: "web", entries: [], unavailable: { message: "GitHub is out of reach.", retry: true } },
};
const place = { root: "", outside: false };
const READS: Record<string, FileRead> = {
  "README.md": { kind: "file", ...place, path: "README.md", absolutePath: "", version: "a".repeat(64), text: "# Plans\nFree, Pro and Team.\n", readOnly: null } as FileRead,
  "empty.txt": { kind: "file", ...place, path: "empty.txt", absolutePath: "", version: "b".repeat(64), text: "", readOnly: null } as FileRead,
  "board.png": { kind: "binary", ...place, path: "board.png", absolutePath: "", media: "image", mime: "image/png", size: 2048, url: "" } as FileRead,
  "plans.pdf": { kind: "binary", ...place, path: "plans.pdf", absolutePath: "", media: "pdf", mime: "application/pdf", size: 16384, url: "" } as FileRead,
  "gone.ts": { kind: "missing", ...place, path: "gone.ts" } as FileRead,
};

const mac = vi.hoisted(() => ({
  phone: null as FakeMac | null,
  state: null as unknown,
  params: {} as Record<string, string>,
  cloud: false,
  calls: [] as [string, unknown][],
  own: false,
  refused: false,
}));
const saved = { from: "save" as const, savedAt: new Date(Date.now() - 600_000).toISOString() };
/** The phone's own session of OpenOrc Cloud, which holds thread t1 and reads its files from the server. */
const ownCloud = vi.hoisted(() => ({
  served: [] as string[],
  threadFiles: {
    list: vi.fn(),
    search: vi.fn(),
    read: vi.fn(),
  },
}));
vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac((method: RpcMethod, params) => {
    mac.calls.push([method, params]);
    const { path, query } = params as { path?: string; query?: string };
    if (method === "threads.get") return Promise.resolve({ id: "t1", title: "Plans", owner: mac.cloud ? { brain: "hosted", reach: "live", heardAt: 0 } : undefined });
    if (method === "files.list") return LISTINGS[path!] ? Promise.resolve(LISTINGS[path!]) : Promise.reject(new Error("This project isn't on Studio."));
    if (method === "files.read") return Promise.resolve(READS[path!]);
    if (method === "files.search") return Promise.resolve(query === "team" ? ["src/plans/team.ts"] : []);
    if (method === "hosted.capabilities") return Promise.resolve({ version: 1, features: { threadFiles: { available: true } } });
    if (method === "threads.cloudCopy")
      return Promise.resolve({ folder: "", savedAt: new Date(Date.now() - 180_000).toISOString(), head: "h", asOf: { turnId: null, at: new Date(Date.now() - 180_000).toISOString() } });
    return Promise.reject(new Error(`no ${method}`));
  });
  const hosted = { threads: { holds: () => true, row: () => ({ space: "personal" }) }, threadFiles: ownCloud.threadFiles };
  const cloud = {
    ...mac.phone.module.cloud,
    get holds() {
      return mac.own;
    },
    get hosted() {
      return mac.own ? hosted : null;
    },
  };
  return { ...mac.phone.module, cloud, useLinkState: () => mac.state ?? connected };
});
vi.mock("expo-router", () => {
  const Stack = ({ children }: { children?: ReactNode }) => <>{children}</>;
  Stack.Screen = ({ options }: { options: { headerTitle: () => ReactNode } }) => <header>{options.headerTitle()}</header>;
  return { router: { push: vi.fn() }, Stack, useLocalSearchParams: () => mac.params };
});
vi.mock("../thread/images", () => ({
  ImageTile: ({ asset, label }: { asset: unknown; label: string }) => <img alt={label} data-asset={JSON.stringify(asset)} />,
  CloudThreadFileTile: ({ path, label }: { path: string; label: string }) => <img alt={label} data-cloud={path} />,
}));
vi.mock("../changes/PanelTitle", () => ({
  PanelTitle: ({ title, line, fromCloud }: { title: string; line: string | null; fromCloud?: boolean }) => <h1 data-from-cloud={fromCloud}>{[title, line].filter(Boolean).join(" · ")}</h1>,
}));

afterEach(() => {
  cleanup();
  mac.phone!.module.queryClient.clear();
  mac.state = null;
  mac.cloud = false;
  mac.own = false;
  mac.calls = [];
  for (const read of Object.values(ownCloud.threadFiles)) read.mockReset();
  vi.mocked(router.push).mockClear();
});
const search = (query: string) => act(() => (nativeProps.get(screen.getByLabelText("Search files"))!.onChangeText as (text: string) => void)(query));
const show = (ui: ReactNode, params: Record<string, string>) => {
  mac.params = params;
  return render(ui, { wrapper: mac.phone!.wrapper });
};

it("lists a thread's folder by its own name, dims what git ignores, and opens a folder or a file, reading only", async () => {
  show(<FilesScreen />, { threadId: "t1" });
  expect(await screen.findByRole("heading", { name: "web" })).toBeTruthy();
  expect(nativeProps.get(screen.getByText("node_modules"))?.className).toContain("text-ink-4");
  expect(nativeProps.get(screen.getByText("README.md"))?.className).not.toContain("text-ink-4");
  fireEvent.click(screen.getByRole("button", { name: "src, folder" }));
  expect(router.push).toHaveBeenCalledWith({ pathname: "/files", params: { threadId: "t1", path: "src" } });
  fireEvent.click(screen.getByRole("button", { name: "README.md" }));
  expect(router.push).toHaveBeenLastCalledWith({ pathname: "/file", params: { threadId: "t1", path: "README.md" } });
  expect(mac.calls.map(([method]) => method).filter((method) => method.startsWith("files."))).toEqual(["files.list"]);
});

it("says Empty folder for a folder with nothing in it, and the Mac's words for one it cannot list", async () => {
  show(<FilesScreen />, { threadId: "t1", path: "src/plans" });
  expect(await screen.findByText("Empty folder")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "plans · src" })).toBeTruthy();
  cleanup();
  show(<FilesScreen />, { threadId: "t1", path: "elsewhere" });
  expect(await screen.findByText("This project isn't on Studio.", {}, { timeout: 10_000 })).toBeTruthy();
});

it("says once why a cloud thread's copy cannot be had, with Retry only where the Mac says it may help", async () => {
  show(<FilesScreen />, { threadId: "t1", path: "never" });
  expect(await screen.findByText("This thread hasn't saved its work yet.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(screen.queryByText("Empty folder")).toBeNull();
  cleanup();
  show(<FilesScreen />, { threadId: "t1", path: "offline" });
  expect(await screen.findByText("GitHub is out of reach.")).toBeTruthy();
  const listed = mac.calls.filter(([method]) => method === "files.list").length;
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(mac.calls.filter(([method]) => method === "files.list").length).toBe(listed + 1));
});

it("finds files by name at the folder's root, as the desktop's search does", async () => {
  show(<FilesScreen />, { threadId: "t1" });
  await screen.findByRole("heading", { name: "web" });
  search("team");
  fireEvent.click(await screen.findByRole("button", { name: "team.ts, in src/plans" }));
  expect(nativeProps.get(screen.getByText("src/plans"))?.className).toContain("text-ink-4");
  expect(router.push).toHaveBeenCalledWith({ pathname: "/file", params: { threadId: "t1", path: "src/plans/team.ts" } });
  search("nothing");
  expect(await screen.findByText("No file names match.")).toBeTruthy();
});

it("says how old a cloud thread's copy is at its root, and below it where a folder is", async () => {
  mac.cloud = true;
  show(<FilesScreen />, { threadId: "t1" });
  expect(await screen.findByRole("heading", { name: "web · Saved 3m ago" })).toBeTruthy();
  cleanup();
  show(<FilesScreen />, { threadId: "t1", path: "src/plans" });
  expect(await screen.findByRole("heading", { name: "plans · src" })).toBeTruthy();
});

it("keeps a folder read before with when it was read while the Mac is out of reach, and waits for the Mac for one never read", async () => {
  const view = show(<FilesScreen />, { threadId: "t1" });
  await screen.findByRole("button", { name: "README.md" });
  mac.state = asleep;
  view.rerender(<FilesScreen />);
  expect(screen.getByText(/^Read at /)).toBeTruthy();
  expect(screen.getByRole("button", { name: "README.md" })).toBeTruthy();
  cleanup();
  show(<FilesScreen />, { threadId: "t1", path: "src" });
  await waitFor(() => expect(screen.getByText("Waiting for Studio")).toBeTruthy());
  expect(screen.queryByRole("button", { name: "plans, folder" })).toBeNull();
});

it("reads a text file, an empty one, a picture, any other file by name and size, and one that is gone", async () => {
  show(<FileScreen />, { threadId: "t1", path: "README.md" });
  expect(await screen.findByText(/Free, Pro and Team\./)).toBeTruthy();
  cleanup();
  show(<FileScreen />, { threadId: "t1", path: "empty.txt" });
  expect(await screen.findByText("This file is empty.")).toBeTruthy();
  cleanup();
  show(<FileScreen />, { threadId: "t1", path: "board.png" });
  expect((await screen.findByAltText("board.png")).getAttribute("data-asset")).toBe(JSON.stringify({ kind: "thread-file", threadId: "t1", path: "board.png" }));
  cleanup();
  show(<FileScreen />, { threadId: "t1", path: "plans.pdf" });
  expect(await screen.findByLabelText("16 KB")).toBeTruthy();
  expect(screen.queryByText("plans.pdf", { selector: "span:not(h1 span)" })).toBeNull();
  cleanup();
  show(<FileScreen />, { threadId: "t1", path: "gone.ts" });
  expect(await screen.findByText("File not found. It may have moved or been deleted.")).toBeTruthy();
});

it("never shows a file the phone did not read while the Mac is out of reach", async () => {
  mac.state = asleep;
  show(<FileScreen />, { threadId: "t1", path: "README.md" });
  await waitFor(() => expect(screen.getByText("Waiting for Studio")).toBeTruthy());
  expect(screen.queryByText(/Free, Pro and Team/)).toBeNull();
});

it("reads a cloud thread's files from OpenOrc Cloud while the Mac is out of reach, by the save's age, never as kept", async () => {
  mac.state = asleep;
  mac.cloud = true;
  mac.own = true;
  ownCloud.threadFiles.list.mockResolvedValue({
    name: "launch",
    entries: [
      { name: "assets", path: "assets", kind: "directory" },
      { name: "README.md", path: "README.md", kind: "file" },
    ],
    source: saved,
  });
  ownCloud.threadFiles.search.mockResolvedValue({ paths: ["notes/long.txt"], source: saved });
  show(<FilesScreen />, { threadId: "t1" });
  expect((await screen.findByRole("heading", { name: "launch · Saved 10m ago" })).dataset.fromCloud).toBe("true");
  expect(screen.getByRole("button", { name: "README.md" })).toBeTruthy();
  expect(screen.queryByText(/^Read at /)).toBeNull();
  expect(screen.queryByText("Waiting for Studio")).toBeNull();
  expect(ownCloud.threadFiles.list).toHaveBeenCalledWith("personal", "t1", "");
  expect(mac.calls.map(([method]) => method)).not.toContain("files.list");
  search("long");
  expect(await screen.findByRole("button", { name: "long.txt, in notes" })).toBeTruthy();
});

it("says once why the cloud will not show a reader the files, with no search to make", async () => {
  mac.state = asleep;
  mac.cloud = true;
  mac.own = true;
  ownCloud.threadFiles.list.mockResolvedValue({ name: "launch", entries: [], source: saved, unavailable: { message: "Hosted threads are part of Pro.", retry: false } });
  show(<FilesScreen />, { threadId: "t1" });
  expect(await screen.findByText("Hosted threads are part of Pro.")).toBeTruthy();
  expect(screen.queryByLabelText("Search files")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

it("reads a cloud thread's file and its picture from OpenOrc Cloud while the Mac is out of reach", async () => {
  mac.state = asleep;
  mac.cloud = true;
  mac.own = true;
  ownCloud.threadFiles.read.mockImplementation(async (_space: string, _thread: string, path: string) =>
    path === "README.md" ? { kind: "file", text: "# Launch\nSpring page.\n", size: 22, source: saved } : { kind: "binary", media: "image", mime: "image/png", size: 4096, source: saved },
  );
  show(<FileScreen />, { threadId: "t1", path: "README.md" });
  expect(await screen.findByText(/Spring page\./)).toBeTruthy();
  expect(screen.queryByText(/^Read at /)).toBeNull();
  cleanup();
  show(<FileScreen />, { threadId: "t1", path: "assets/hero.png" });
  expect((await screen.findByAltText("hero.png")).getAttribute("data-cloud")).toBe("assets/hero.png");
});

it("keeps reading through the Mac while it is connected, cloud thread or not", async () => {
  mac.cloud = true;
  mac.own = true;
  show(<FilesScreen />, { threadId: "t1" });
  expect(await screen.findByRole("button", { name: "README.md" })).toBeTruthy();
  expect(ownCloud.threadFiles.list).not.toHaveBeenCalled();
});
