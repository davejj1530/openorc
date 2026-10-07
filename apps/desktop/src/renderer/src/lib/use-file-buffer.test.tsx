import "fake-indexeddb/auto";
import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileVersion, FolderPath, type FileRead, type FileWriteResult, type FormatResult, type RpcMethod, type RpcResults } from "@openorc/protocol";
import { useDrafts } from "./file-drafts";
import { queryClient } from "./query";
import { core } from "./rpc";
import { formatFile, saveFile, useFileBuffer } from "./use-file-buffer";

const [v1, v2] = ["1", "2"].map((digit) => FileVersion.parse(digit.repeat(64))) as [FileVersion, FileVersion];
const path = FolderPath.parse("src/cart.ts");
const selection = { scope: { kind: "thread", id: "t1" }, path: "src/cart.ts" } as const;
const onDisk = (version: FileVersion, text: string): FileRead => ({ kind: "file", root: "/repo", path, absolutePath: "/repo/src/cart.ts", version, text, readOnly: null });
const saved: FileWriteResult = { kind: "saved", root: "/repo", path, absolutePath: "/repo/src/cart.ts", version: v2, text: null, formatError: null };
let disk: FileRead;
let answer: () => Promise<FileWriteResult>;
let formatted: () => Promise<FormatResult>;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;

beforeEach(() => {
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  useDrafts.setState({ keys: new Set(), ready: true, loaded: new Map(), failed: false });
  disk = onDisk(v1, "disk");
  answer = async () => saved;
  formatted = async () => ({ kind: "formatted", text: "FORMATTED" });
  vi.spyOn(core, "call").mockImplementation(async <M extends RpcMethod>(method: M): Promise<RpcResults[M]> => {
    if (method === "files.read") return disk as RpcResults[M];
    if (method === "files.write") return (await answer()) as RpcResults[M];
    if (method === "files.format") return (await formatted()) as RpcResults[M];
    throw new Error(`unexpected ${method}`);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function openBuffer() {
  const shown: string[] = [];
  const hook = renderHook(
    () => {
      const buffer = useFileBuffer(selection);
      shown.push(`${buffer.view.kind}:${buffer.text}`);
      return buffer;
    },
    { wrapper },
  );
  await waitFor(() => expect(hook.result.current.view.kind).toBe("clean"));
  return { hook, shown };
}

it("shows the saved text and drops the draft in the same render, never the old text or a conflict", async () => {
  const { hook, shown } = await openBuffer();
  act(() => hook.result.current.edit("mine"));
  expect(hook.result.current.view.kind).toBe("dirty");
  shown.length = 0;
  // Outside act, so React schedules renders as it does in the app and an in-between render would be seen.
  const saving = saveFile(selection);
  await waitFor(() => expect(hook.result.current.view).toMatchObject({ kind: "clean", file: { version: v2, text: "mine" } }));
  await saving;
  expect(shown.filter((render) => render !== "dirty:mine" && render !== "clean:mine")).toEqual([]);
});

it("keeps typing from during a save as a draft on the saved version", async () => {
  const { hook } = await openBuffer();
  act(() => hook.result.current.edit("mine"));
  let land!: (result: FileWriteResult) => void;
  answer = () => new Promise((resolve) => (land = resolve));
  const saving = saveFile(selection);
  await waitFor(() => expect(hook.result.current.saving).toBe(true));
  act(() => hook.result.current.edit("mine, more"));
  await act(async () => {
    land(saved);
    await saving;
  });
  expect(hook.result.current.view).toMatchObject({ kind: "dirty", file: { version: v2, text: "mine" }, draft: { text: "mine, more", base: v2 } });
});

it("shows the file as it is now when the save finds it changed", async () => {
  const { hook } = await openBuffer();
  act(() => hook.result.current.edit("mine"));
  answer = async () => ({ kind: "conflict", current: onDisk(v2, "theirs") });
  await act(() => saveFile(selection));
  expect(hook.result.current.view).toMatchObject({ kind: "conflict", file: { text: "theirs" }, draft: { text: "mine", base: v1 } });
});

it("says quietly why a save wasn't formatted, until the next edit", async () => {
  const { hook } = await openBuffer();
  act(() => hook.result.current.edit("mine"));
  answer = async () => ({ ...saved, formatError: "Prettier: Unexpected token (1:3)" });
  await act(() => saveFile(selection));
  expect(hook.result.current).toMatchObject({ note: "Saved without formatting. Prettier: Unexpected token (1:3)", error: null });
  act(() => hook.result.current.edit("mine!"));
  expect(hook.result.current.note).toBeNull();
});

it("formats what the editor holds into an unsaved edit, and drops a format that typing overtook", async () => {
  const { hook } = await openBuffer();
  act(() => hook.result.current.edit("mine"));
  await act(() => formatFile(selection));
  expect(hook.result.current.view).toMatchObject({ kind: "dirty", draft: { text: "FORMATTED", base: v1 } });
  expect(vi.mocked(core.call).mock.calls.filter(([method]) => method === "files.write")).toEqual([]);
  let land!: (result: FormatResult) => void;
  formatted = () => new Promise((resolve) => (land = resolve));
  const formatting = formatFile(selection);
  act(() => hook.result.current.edit("FORMATTED, more"));
  await act(async () => {
    land({ kind: "formatted", text: "STALE" });
    await formatting;
  });
  expect(hook.result.current.view).toMatchObject({ kind: "dirty", draft: { text: "FORMATTED, more" } });
});
