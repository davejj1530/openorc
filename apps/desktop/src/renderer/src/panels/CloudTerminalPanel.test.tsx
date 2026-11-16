import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HostedTerminal, HostedTerminalPush, HostedTerminals } from "@openorc/protocol";
import { queryClient } from "../lib/client";
import { CloudTerminalPanel } from "./CloudTerminalPanel";

const screenState = vi.hoisted(() => ({ written: [] as string[], options: {} as Record<string, unknown>, type: (_data: string) => {} }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = screenState.options;
    element = undefined;
    loadAddon() {}
    open() {}
    focus() {}
    write(data: Uint8Array | string) {
      screenState.written.push(typeof data === "string" ? data : new TextDecoder().decode(data));
    }
    onData(listener: (data: string) => void) {
      screenState.type = listener;
      return { dispose() {} };
    }
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock("./terminal-theme", () => ({ terminalTheme: () => ({}) }));
vi.mock("./terminal-font", () => ({ followTerminalFont: () => () => {} }));
const mock = vi.hoisted(() => ({ call: vi.fn<(method: string, params: Record<string, unknown>) => Promise<unknown>>(), listener: (_push: HostedTerminalPush) => {} }));
vi.mock("../lib/rpc", () => ({
  core: {
    call: mock.call,
    onPush: () => () => {},
    onReady: () => () => {},
    onHostedTerminal: (fn: (push: HostedTerminalPush) => void) => {
      mock.listener = fn;
      return () => {};
    },
  },
}));

const ANA = { id: "user-ana", name: "Ana Rivera", image: null };
const BEN = { id: "user-ben", name: "Ben Okafor", image: null };
const terminal = (over: Partial<HostedTerminal> = {}): HostedTerminal => ({ id: "terminal-1", threadId: "thread", openedBy: ANA, state: "open", cols: 80, rows: 24, typed: 5, ended: null, ...over });
let listed: HostedTerminals;
let output: string;
const b64 = (text: string) => btoa(text);

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  screenState.written = [];
  screenState.options = {};
  screenState.type = () => {};
  queryClient.clear();
  output = "$ ls\r\n";
  listed = { terminals: [terminal()], canOpen: true, reason: null, viewer: ANA.id };
  mock.call.mockReset();
  mock.call.mockImplementation(async (method, params) => {
    if (method === "hosted.terminal.list") return listed;
    if (method === "hosted.terminal.output") {
      const from = params["from"] as number;
      return { from, end: output.length, data: b64(output.slice(from)), terminal: listed.terminals[0] };
    }
    if (method === "hosted.terminal.input") return { at: (params["at"] as number) + (params["data"] as string).length };
    if (method === "hosted.terminal.open") return terminal({ id: "terminal-2", typed: 0 });
    if (method === "hosted.terminal.end") return terminal({ state: "ended" });
    return null;
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.unstubAllGlobals();
});

function show() {
  render(
    <QueryClientProvider client={queryClient}>
      <CloudTerminalPanel threadId="thread" />
    </QueryClientProvider>,
  );
}
const calls = (method: string) => mock.call.mock.calls.filter(([called]) => called === method).map(([, params]) => params);

it("shows its opener their terminal from the start, follows it live by offset, reads a gap again, and types on from where it stands", async () => {
  show();
  expect(await screen.findByText("OpenOrc Cloud")).toBeTruthy();
  await waitFor(() => expect(screenState.written.join("")).toBe("$ ls\r\n"));
  expect(calls("hosted.terminal.watch")).toEqual([{ threadId: "thread", terminalId: "terminal-1", watch: true }]);
  // Live output at the offset it has, then a frame past a gap, read again from where the screen is.
  act(() => mock.listener({ type: "hosted.terminal", terminalId: "terminal-1", event: { kind: "output", at: 6, data: b64("one\r\n") } }));
  await waitFor(() => expect(screenState.written.join("")).toBe("$ ls\r\none\r\n"));
  output = "$ ls\r\none\r\ntwo\r\nthree\r\n";
  act(() => mock.listener({ type: "hosted.terminal", terminalId: "terminal-1", event: { kind: "output", at: 16, data: b64("three\r\n") } }));
  await waitFor(() => expect(screenState.written.join("")).toBe(output));
  // A frame already shown is not shown twice.
  act(() => mock.listener({ type: "hosted.terminal", terminalId: "terminal-1", event: { kind: "output", at: 6, data: b64("one\r\n") } }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screenState.written.join("")).toBe(output);
  // Keystrokes, in order, from the terminal's typing.
  act(() => screenState.type("p"));
  act(() => screenState.type("wd\r"));
  await waitFor(() =>
    expect(calls("hosted.terminal.input")).toEqual([
      { threadId: "thread", terminalId: "terminal-1", at: 5, data: "p" },
      { threadId: "thread", terminalId: "terminal-1", at: 6, data: "wd\r" },
    ]),
  );
  expect(screen.getByRole("button", { name: "Restart terminal" })).toBeTruthy();
});

it("shows a teammate the opener's terminal to watch: no keystrokes, no Restart, and End named for whose it is", async () => {
  listed = { terminals: [terminal()], canOpen: false, reason: "Ana's terminal is open here. End it to open yours.", viewer: BEN.id };
  show();
  expect(await screen.findByText("Ana's")).toBeTruthy();
  await waitFor(() => expect(screenState.written.join("")).toBe("$ ls\r\n"));
  expect(screenState.options["disableStdin"]).toBe(true);
  expect(screenState.options["cursorInactiveStyle"]).toBe("none");
  act(() => screenState.type("x"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(calls("hosted.terminal.input")).toEqual([]);
  expect(screen.queryByRole("button", { name: "Restart terminal" })).toBeNull();
  const endButton = screen.getByRole("button", { name: "End terminal" });
  expect(endButton.getAttribute("data-tip")).toBe("End Ana's terminal");
  fireEvent.click(endButton);
  await waitFor(() => expect(calls("hosted.terminal.end")).toEqual([{ threadId: "thread", terminalId: "terminal-1" }]));
});

it("says only the server's reason for an end, beside the output it kept, and starts a new one on asking", async () => {
  listed = { terminals: [terminal({ state: "ended", ended: { reason: "exited", message: "The shell exited with code 3.", exitCode: 3, by: null } })], canOpen: true, reason: null, viewer: ANA.id };
  output = "$ exit 3\r\nlogout\r\n";
  show();
  const notice = await screen.findByRole("status");
  expect(notice.textContent).toBe("The shell exited with code 3. Start a new one");
  await waitFor(() => expect(screenState.written.join("")).toBe(output));
  expect(screen.getByRole("button", { name: "End terminal" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Start a new one" }));
  await waitFor(() => expect(calls("hosted.terminal.open")).toHaveLength(1));
  expect(calls("hosted.terminal.end")).toEqual([]);
});

it("opens a terminal for a reader who may when the thread has none, and says why not for one who may not", async () => {
  listed = { terminals: [], canOpen: true, reason: null, viewer: ANA.id };
  show();
  await waitFor(() => expect(calls("hosted.terminal.open")).toEqual([{ threadId: "thread", cols: 100, rows: 24 }]));
  cleanup();
  queryClient.clear();
  mock.call.mockClear();
  listed = { terminals: [], canOpen: false, reason: "You can read this thread but not run its work.", viewer: BEN.id };
  show();
  expect(await screen.findByText("You can read this thread but not run its work.")).toBeTruthy();
  expect(calls("hosted.terminal.open")).toEqual([]);
});
