import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HostedTerminal, HostedTerminalPush, HostedTerminals } from "@openorc/protocol";
import { queryClient } from "../lib/client";
import { CloudTerminalPanel } from "./CloudTerminalPanel";

const screenState = vi.hoisted(() => ({ written: [] as string[], options: {} as Record<string, unknown>, type: (_data: string) => {}, cols: 80, rows: 24 }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = screenState.cols;
    rows = screenState.rows;
    options = screenState.options;
    element = undefined;
    loadAddon() {}
    open() {}
    focus() {}
    blur() {}
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
    // As in a browser, a screen is heard once as it is first observed.
    class {
      constructor(private readonly heard: () => void) {}
      observe() {
        queueMicrotask(this.heard);
      }
      disconnect() {}
    },
  );
  screenState.written = [];
  screenState.options = {};
  screenState.type = () => {};
  screenState.cols = 80;
  screenState.rows = 24;
  localStorage.clear();
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

function show(slot = "main") {
  return render(
    <QueryClientProvider client={queryClient}>
      <CloudTerminalPanel threadId="thread" slot={slot} />
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

it("types on from where the typing stands when its screen is made again, never from the terminal's older record", async () => {
  listed = { terminals: [terminal({ id: "terminal-again", typed: 5 })], canOpen: true, reason: null, viewer: ANA.id };
  const first = show();
  await waitFor(() => expect(screenState.written.join("")).toBe("$ ls\r\n"));
  act(() => screenState.type("printf hi\r"));
  await waitFor(() => expect(calls("hosted.terminal.input")).toHaveLength(1));
  // Away to Changes and back: the screen is made again from the same record, which still says 5.
  first.unmount();
  show();
  await waitFor(() => expect(screenState.written.join("")).toContain("$ ls"));
  act(() => screenState.type("ls\r"));
  await waitFor(() =>
    expect(calls("hosted.terminal.input")).toEqual([
      { threadId: "thread", terminalId: "terminal-again", at: 5, data: "printf hi\r" },
      { threadId: "thread", terminalId: "terminal-again", at: 15, data: "ls\r" },
    ]),
  );
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
  await waitFor(() => expect(calls("hosted.terminal.open")).toEqual([{ threadId: "thread", cols: 80, rows: 24 }]));
  cleanup();
  queryClient.clear();
  mock.call.mockClear();
  listed = { terminals: [], canOpen: false, reason: "You can read this thread but not run its work.", viewer: BEN.id };
  show();
  expect(await screen.findByText("You can read this thread but not run its work.")).toBeTruthy();
  expect(calls("hosted.terminal.open")).toEqual([]);
});

it("opens a terminal at the size its screen settles at, so its shell starts as wide as the view, and shows it from the open's answer", async () => {
  listed = { terminals: [], canOpen: true, reason: null, viewer: ANA.id };
  const answer = mock.call.getMockImplementation()!;
  let reads = 0;
  // The list is read once; read again after the open, it hasn't answered yet.
  mock.call.mockImplementation((method, params) => (method === "hosted.terminal.list" && reads++ > 0 ? new Promise(() => {}) : answer(method, params)));
  screenState.cols = 63;
  screenState.rows = 17;
  show();
  await waitFor(() => expect(calls("hosted.terminal.open")).toEqual([{ threadId: "thread", cols: 63, rows: 17 }]));
  await waitFor(() => expect(calls("hosted.terminal.watch")).toEqual([{ threadId: "thread", terminalId: "terminal-2", watch: true }]));
  expect(reads).toBe(2);
});

it("hides the cursor and takes no keys once the terminal has ended", async () => {
  listed = { terminals: [terminal({ state: "ended", ended: { reason: "closed", message: "Ben ended this terminal.", exitCode: null, by: BEN } })], canOpen: true, reason: null, viewer: ANA.id };
  show();
  await screen.findByText(/Ben ended this terminal\./);
  await waitFor(() => expect(screenState.options["disableStdin"]).toBe(true));
  expect(screenState.options["cursorInactiveStyle"]).toBe("none");
});

it("gives a second Terminal tab a terminal of its own, and finds each tab's again after the app opens anew", async () => {
  show("main");
  await waitFor(() => expect(screenState.written.join("")).toBe("$ ls\r\n"));
  expect(calls("hosted.terminal.open")).toEqual([]);
  // A second tab: the thread's one open terminal is the first tab's, so it opens another.
  show("shell-2");
  await waitFor(() => expect(calls("hosted.terminal.open")).toEqual([{ threadId: "thread", cols: 80, rows: 24 }]));
  cleanup();
  queryClient.clear();
  mock.call.mockClear();
  // Opened anew: each tab shows the terminal it held, and nothing is opened.
  listed = { terminals: [terminal({ id: "terminal-2", typed: 0 }), terminal()], canOpen: true, reason: null, viewer: ANA.id };
  show("shell-2");
  await waitFor(() => expect(calls("hosted.terminal.watch")).toEqual([{ threadId: "thread", terminalId: "terminal-2", watch: true }]));
  expect(calls("hosted.terminal.open")).toEqual([]);
});

it("says the server's refusal in a tab past the most a thread keeps open", async () => {
  listed = { terminals: [terminal()], canOpen: true, reason: null, viewer: ANA.id };
  mock.call.mockImplementation(async (method) => {
    if (method === "hosted.terminal.list") return listed;
    if (method === "hosted.terminal.open") throw new Error("A thread keeps up to 4 terminals open. Close one first.");
    return null;
  });
  show("main");
  show("shell-5");
  expect(await screen.findByText("A thread keeps up to 4 terminals open. Close one first.")).toBeTruthy();
});

it("restarts its opener's own terminal with the most open: ended first, its end waited for, then a new one", async () => {
  let ended = false;
  listed = { terminals: [terminal()], canOpen: false, reason: "A thread keeps up to 4 terminals open. Close one first.", viewer: ANA.id };
  mock.call.mockImplementation(async (method) => {
    if (method === "hosted.terminal.list")
      return ended
        ? { ...listed, terminals: [terminal({ state: "ended", ended: { reason: "closed", message: "Ana ended this terminal.", exitCode: null, by: ANA } })], canOpen: true, reason: null }
        : listed;
    if (method === "hosted.terminal.end") {
      setTimeout(() => (ended = true), 400);
      return terminal();
    }
    if (method === "hosted.terminal.open") return terminal({ id: "terminal-2", typed: 0 });
    if (method === "hosted.terminal.output") return { from: 0, end: 0, data: "", terminal: terminal() };
    return null;
  });
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Restart terminal" }));
  await waitFor(() => expect(calls("hosted.terminal.open")).toHaveLength(1), { timeout: 4000 });
  const order = mock.call.mock.calls.map(([method]) => method).filter((method) => method === "hosted.terminal.end" || method === "hosted.terminal.open");
  expect(order).toEqual(["hosted.terminal.end", "hosted.terminal.open"]);
  expect(ended).toBe(true);
});
