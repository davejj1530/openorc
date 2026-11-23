import { appendCrashLog } from "../shared/crash-log";

/** How much of what a core printed last is kept for its log. */
const KEEP_CHARS = 16_000;
/** How long after a core stops what it printed may still be on its way. */
const SETTLE_MS = 1_000;

interface Output {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  once(event: "close", listener: () => void): unknown;
}

interface PrintingCore {
  stdout: Output | null;
  stderr: Output | null;
  once(event: "exit", listener: (code: number) => void): unknown;
}

/**
 * Passes on what the core prints, as before, and keeps the last of it. A core that exits with a failure has its code
 * and those last words added to its log: a fatal error V8 prints on its way out reaches only main, never the core's own
 * record of an uncaught error.
 */
export function keepCoreOutput(child: PrintingCore, file: string, echo: { out(text: string): void; err(text: string): void }): void {
  let tail = "";
  const keep = (text: string) => {
    tail = (tail + text).slice(-KEEP_CHARS);
  };
  child.stdout?.on("data", (chunk) => {
    echo.out(`[core] ${chunk}`);
    keep(String(chunk));
  });
  child.stderr?.on("data", (chunk) => {
    echo.err(`[core!] ${chunk}`);
    keep(String(chunk));
  });
  child.once("exit", (code) => {
    if (code === 0) return;
    let written = false;
    const write = () => {
      if (written) return;
      written = true;
      clearTimeout(timer);
      appendCrashLog(file, `The core exited with code ${code}. ${tail.trim() ? `The last it printed:\n${tail.trimEnd()}` : "It printed nothing."}`);
    };
    // The last of its output can arrive after the exit: wait for the stream to close, but not for long.
    const timer = setTimeout(write, SETTLE_MS);
    child.stderr?.once("close", write);
  });
}
