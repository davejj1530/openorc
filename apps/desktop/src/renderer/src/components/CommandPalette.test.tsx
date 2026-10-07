import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RpcMethod, RpcResults } from "@openorc/protocol";
import { queryClient } from "../lib/query";
import { useFilesTool } from "../lib/files-tool";
import { core } from "../lib/rpc";
import { useRouter } from "../lib/router";
import { useUi } from "../lib/ui";
import { CommandPalette } from "./CommandPalette";

function PaletteHost() {
  const open = useUi((s) => s.palette);
  const setPalette = useUi((s) => s.setPalette);
  return (
    <QueryClientProvider client={queryClient}>
      <input aria-label="Editor" onKeyDown={(event) => event.preventDefault()} />
      <input aria-label="Notes" />
      <CommandPalette open={open} onOpenChange={setPalette} />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  queryClient.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(core, "call").mockImplementation(async <M extends RpcMethod>(): Promise<RpcResults[M]> => [] as unknown as RpcResults[M]);
  useUi.setState({ palette: false, paletteMode: "all", newFile: null });
  useRouter.setState({ route: { view: "inbox" } });
  useFilesTool.setState({ host: null });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("opens on ⌘K", () => {
  render(<PaletteHost />);
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Notes" }), { key: "k", metaKey: true });
  expect(screen.getByRole("combobox")).toBeTruthy();
});

it("stays closed when what had focus already handled ⌘K, as an editor's link command does", () => {
  render(<PaletteHost />);
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Editor" }), { key: "k", metaKey: true });
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(useUi.getState().palette).toBe(false);
});

it("offers New file only while a conversation's panel is on screen, and asks for a path in that conversation's folder", () => {
  render(<PaletteHost />);
  act(() => useUi.getState().setPalette(true));
  expect(screen.getByRole("option", { name: "New task" })).toBeTruthy();
  expect(screen.queryByRole("option", { name: "New file" })).toBeNull();
  act(() => useUi.getState().setPalette(false));
  useFilesTool.setState({ host: { kind: "task", id: "task" } });
  act(() => useUi.getState().setPalette(true));
  fireEvent.click(screen.getByRole("option", { name: "New file" }));
  expect(useUi.getState()).toMatchObject({ palette: false, newFile: { kind: "task", id: "task" } });
});

it("puts New file in the focused thread's folder", () => {
  useRouter.setState({ route: { view: "thread", threadId: "focused" } });
  useFilesTool.setState({ host: { kind: "thread", id: "other" } });
  render(<PaletteHost />);
  act(() => useUi.getState().setPalette(true));
  fireEvent.click(screen.getByRole("option", { name: "New file" }));
  expect(useUi.getState().newFile).toEqual({ kind: "thread", id: "focused" });
});
