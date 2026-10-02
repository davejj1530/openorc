import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenOrcApi } from "../../../shared/types";
import { runInTerminal } from "../lib/terminal-requests";
import { TerminalPanel } from "./TerminalPanel";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
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
    fit() {}
  },
}));
vi.mock("./terminal-theme", () => ({ terminalTheme: () => ({}) }));

const PROMPT = "\x1b[?2004h";
let output: (chunk: string) => void;
const terminal = {
  attach: vi.fn(),
  detach: vi.fn(),
  open: vi.fn(async () => ({ backlog: "", running: true, exitCode: null as number | null })),
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
  window.openorc = { terminal } as unknown as OpenOrcApi;
});
afterEach(() => {
  cleanup();
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

it("keeps the command for the next shell when this one has ended", async () => {
  terminal.open.mockResolvedValueOnce({ backlog: `repo % ${PROMPT}exit\r\n`, running: false, exitCode: 0 });
  runInTerminal({ kind: "thread", id: "ended" }, "claude auth login");
  await openShell("thread:ended");
  expect(terminal.write).not.toHaveBeenCalled();
});
