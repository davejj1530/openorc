import { afterEach, describe, expect, it, vi } from "vitest";
import { commandSettleWatcher } from "./command-settle";

const ECHO = "\x1b[?2004l\r\r\n";
const PROMPT = "\r\n~/repo % \x1b[?2004h";

afterEach(() => {
  vi.useRealTimers();
});

describe("commandSettleWatcher", () => {
  it("reports a quick command once its output and prompt settle", () => {
    vi.useFakeTimers();
    const settled = vi.fn();
    const watcher = commandSettleWatcher(settled, 800);
    watcher.input("git stash\r");
    watcher.output(ECHO);
    watcher.output("Saved working directory");
    watcher.output(PROMPT);
    vi.advanceTimersByTime(799);
    expect(settled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(settled).toHaveBeenCalledTimes(1);
    watcher.output("\x1b]2;title\x07");
    vi.advanceTimersByTime(5_000);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("ignores output that no command started, and keystrokes without Enter", () => {
    vi.useFakeTimers();
    const settled = vi.fn();
    const watcher = commandSettleWatcher(settled, 800);
    watcher.output("background job output");
    watcher.input("vim notes.txt");
    watcher.output("vim notes.txt");
    vi.advanceTimersByTime(5_000);
    expect(settled).not.toHaveBeenCalled();
  });

  it("reports a command that keeps printing at most every 8 seconds, and its prompt return at once", () => {
    vi.useFakeTimers();
    const settled = vi.fn();
    const watcher = commandSettleWatcher(settled, 800, 8_000);
    watcher.input("tail -f app.log\r");
    for (let second = 0; second < 10; second += 1) {
      watcher.output("log line\r\n");
      vi.advanceTimersByTime(1_000);
    }
    expect(settled).toHaveBeenCalledTimes(2);
    watcher.output("^C\r\n~ % \x1b[?2004h");
    vi.advanceTimersByTime(800);
    expect(settled).toHaveBeenCalledTimes(3);
  });
});
