import type { ChildProcess } from "node:child_process";

const stopped = new WeakSet<ChildProcess>();

function groupExists(proc: ChildProcess): boolean {
  if (process.platform === "win32" || !proc.pid) return false;
  try {
    process.kill(-proc.pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
}

/** A wrapper's closed pipes do not prove its redirected descendants stopped writing. */
export async function waitForProcessGroup(proc: ChildProcess): Promise<void> {
  while (groupExists(proc))
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 25);
      timer.unref();
    });
}

/** The CLI may be an npm wrapper. Its native child owns the session writer. */
export function stopProcess(proc: ChildProcess): void {
  if (stopped.has(proc)) return;
  stopped.add(proc);
  const signal = (kind: NodeJS.Signals): boolean => {
    if (process.platform !== "win32" && proc.pid) {
      try {
        process.kill(-proc.pid, kind);
        return false;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Darwin can report EPERM while a naturally exiting group disappears.
        // Only ESRCH from a fresh probe proves this was an exit race; a live or
        // inaccessible group still needs the caller's writer fence.
        if (code === "EPERM" && !groupExists(proc)) return true;
        if (code !== "ESRCH") throw error;
      }
    }
    proc.kill(kind);
    return false;
  };
  const failed = () => {
    stopped.delete(proc);
    clearTimeout(timer);
    proc.removeListener("close", onClosed);
  };
  const timer = setTimeout(() => {
    try {
      signal("SIGKILL");
    } catch {
      // This callback cannot throw into the host. waitForProcessGroup keeps
      // waiting while any writer remains; a later Stop must be able to retry.
      failed();
    }
  }, 2000);
  timer.unref();
  const onClosed = () => {
    if (!groupExists(proc)) clearTimeout(timer);
  };
  proc.once("close", onClosed);
  try {
    if (signal("SIGTERM")) {
      clearTimeout(timer);
      proc.removeListener("close", onClosed);
    }
  } catch (error) {
    failed();
    throw error;
  }
}
