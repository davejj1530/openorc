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

const mac = vi.hoisted(() => ({ phone: null as FakeMac | null, state: null as unknown, params: {} as Record<string, string>, cloud: false, calls: [] as [string, unknown][] }));
vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  mac.phone = fakeMac((method: RpcMethod, params) => {
    mac.calls.push([method, params]);
    const { path, query } = params as { path?: string; query?: string };
    if (method === "threads.get") return Promise.resolve({ id: "t1", title: "Plans", owner: mac.cloud ? { brain: "hosted", reach: "live", heardAt: 0 } : undefined });
    if (method === "files.list") return LISTINGS[path!] ? Promise.resolve(LISTINGS[path!]) : Promise.reject(new Error("This project isn't on Studio."));
    if (method === "files.read") return Promise.resolve(READS[path!]);
    if (method === "files.search") return Promise.resolve(query === "team" ? ["src/plans/team.ts"] : []);
    if (method === "threads.cloudCopy")
      return Promise.resolve({ folder: "", savedAt: new Date(Date.now() - 180_000).toISOString(), head: "h", asOf: { turnId: null, at: new Date(Date.now() - 180_000).toISOString() } });
    return Promise.reject(new Error(`no ${method}`));
  });
  return { ...mac.phone.module, useLinkState: () => mac.state ?? connected };
});
vi.mock("expo-router", () => {
  const Stack = ({ children }: { children?: ReactNode }) => <>{children}</>;
  Stack.Screen = ({ options }: { options: { headerTitle: () => ReactNode } }) => <header>{options.headerTitle()}</header>;
  return { router: { push: vi.fn() }, Stack, useLocalSearchParams: () => mac.params };
});
vi.mock("../thread/images", () => ({ ImageTile: ({ asset, label }: { asset: unknown; label: string }) => <img alt={label} data-asset={JSON.stringify(asset)} /> }));
vi.mock("../changes/PanelTitle", () => ({ PanelTitle: ({ title, line }: { title: string; line: string | null }) => <h1>{[title, line].filter(Boolean).join(" · ")}</h1> }));

afterEach(() => {
  cleanup();
  mac.phone!.module.queryClient.clear();
  mac.state = null;
  mac.cloud = false;
  mac.calls = [];
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
  expect(screen.getByRole("heading", { name: "plans" })).toBeTruthy();
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
  fireEvent.click(await screen.findByRole("button", { name: "src/plans/team.ts" }));
  expect(router.push).toHaveBeenCalledWith({ pathname: "/file", params: { threadId: "t1", path: "src/plans/team.ts" } });
  search("nothing");
  expect(await screen.findByText("No file names match.")).toBeTruthy();
});

it("says how old a cloud thread's copy is", async () => {
  mac.cloud = true;
  show(<FilesScreen />, { threadId: "t1" });
  expect(await screen.findByRole("heading", { name: "web · Saved 3m ago" })).toBeTruthy();
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
  expect(await screen.findByLabelText("plans.pdf, 16 KB")).toBeTruthy();
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
