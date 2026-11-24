import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenOrcApi } from "../../../shared/types";
import { runInTerminal } from "../lib/terminal-requests";
import { useCodeFont } from "../lib/code-font";
import { TerminalPanel } from "./TerminalPanel";

const fontChange = vi.hoisted(() => ({ create: vi.fn(), fit: vi.fn() }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    constructor() {
      fontChange.create();
    }
    cols = 80;
    rows = 24;
    options = {};
    unicode = {};
    loadAddon() {}
    open() {}
    write() {}
    onData() {
      return { dispose() {} };
    }
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {
      fontChange.fit();
    }
  },
}));
vi.mock("./terminal-theme", () => ({ terminalTheme: () => ({}) }));

const PROMPT = "\x1b[?2004h";
let output: (chunk: string) => void;
const terminal = {
  attach: vi.fn(),
  detach: vi.fn(),
  open: vi.fn(async (_input: unknown): Promise<Awaited<ReturnType<OpenOrcApi["terminal"]["open"]>>> => ({ backlog: "", running: true, exitCode: null })),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
  onData: vi.fn((_id: string, listener: (chunk: string) => void) => {
    output = listener;
    return () => {};
  }),
  onExit: vi.fn(() => () => {}),
  onSettled: vi.fn(() => () => {}),
};

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  window.openorc = { terminal, platform: "darwin", windowsBuild: null } as unknown as OpenOrcApi;
});
afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty("--font-mono");
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function openShell(id: string): Promise<void> {
  render(<TerminalPanel id={id} cwd="/repo" />);
  await act(async () => {});
}

it("types a requested command into a new shell once its prompt is drawn, and only once", async () => {
  runInTerminal({ kind: "thread", id: "fresh" }, "claude auth login");
  await openShell("thread:fresh");
  act(() => output("Last login: Thu Oct 1\r\n"));
  expect(terminal.write).not.toHaveBeenCalled();
  act(() => output(`repo % ${PROMPT}`));
  expect(terminal.write).toHaveBeenCalledWith("thread:fresh", "claude auth login\r");
  act(() => output(`repo % ${PROMPT}`));
  expect(terminal.write).toHaveBeenCalledTimes(1);
});

it("types into a shell already waiting at its prompt as soon as the command is asked for", async () => {
  terminal.open.mockResolvedValueOnce({ backlog: `repo % ${PROMPT}`, running: true, exitCode: null });
  await openShell("thread:open");
  act(() => runInTerminal({ kind: "thread", id: "open" }, "claude auth login"));
  expect(terminal.write).toHaveBeenCalledWith("thread:open", "claude auth login\r");
});

it("waits for a shell that never marks its prompt to go quiet", async () => {
  vi.useFakeTimers();
  runInTerminal({ kind: "task", id: "plain" }, "claude auth login");
  await openShell("task:plain");
  act(() => output("$ "));
  expect(terminal.write).not.toHaveBeenCalled();
  act(() => {
    vi.advanceTimersByTime(800);
  });
  expect(terminal.write).toHaveBeenCalledWith("task:plain", "claude auth login\r");
});

it("says a shell running a command stayed in its folder, and restarts it in the panel's", async () => {
  terminal.open.mockResolvedValueOnce({ backlog: "ready on :3000\r\n", running: true, exitCode: null, stayedIn: "/repo" });
  render(<TerminalPanel id="thread:moved" cwd="/worktrees/openorc/chips" />);
  await act(async () => {});
  expect(screen.getByText(/A command was running, so this shell stayed in \/repo\./)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Restart it in …/openorc/chips" }));
  expect(terminal.kill).toHaveBeenCalledWith("thread:moved");
  await act(async () => {});
  expect(screen.queryByText(/stayed in/)).toBeNull();
  expect(terminal.open).toHaveBeenLastCalledWith({ id: "thread:moved", cwd: "/worktrees/openorc/chips", cols: 80, rows: 24 });
});

it("keeps the command for the next shell when this one has ended", async () => {
  terminal.open.mockResolvedValueOnce({ backlog: `repo % ${PROMPT}exit\r\n`, running: false, exitCode: 0 });
  runInTerminal({ kind: "thread", id: "ended" }, "claude auth login");
  await openShell("thread:ended");
  expect(terminal.write).not.toHaveBeenCalled();
});

it("refits a running terminal after changing fonts without reopening or ending its shell", async () => {
  await openShell("thread:font");
  const fits = fontChange.fit.mock.calls.length;
  document.documentElement.style.setProperty("--font-mono", '"Geist Mono Variable", monospace');
  await act(async () => {
    useCodeFont.getState().setFont("geist-mono");
  });
  expect(fontChange.create).toHaveBeenCalledOnce();
  expect(fontChange.fit.mock.calls.length).toBeGreaterThan(fits);
  expect(terminal.resize).toHaveBeenLastCalledWith("thread:font", 80, 24);
  expect(terminal.open).toHaveBeenCalledOnce();
  expect(terminal.detach).not.toHaveBeenCalled();
  expect(terminal.kill).not.toHaveBeenCalled();
});
