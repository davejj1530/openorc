/** How long a typed command's output must stay quiet before the files it may have changed are read again. */
export const COMMAND_SETTLE_MS = 800;
/** While a command keeps running, such as `tail -f`, it is reported at most this often; the prompt returning reports at once. */
export const RUNNING_SETTLE_MS = 8000;

/** zsh and bash turn bracketed paste back on as they draw the next prompt: the typed command has ended. */
const PROMPT_READY = "\x1b[?2004h";

export interface CommandSettleWatcher {
  /** Keystrokes the user sent to the shell. */
  input(data: string): void;
  /** Output the shell wrote, whether or not anyone is watching it. */
  output(chunk: string): void;
  /** The shell is going away: a typed command not yet reported as finished is reported now. */
  dispose(): void;
}

/**
 * Watches one shell for commands the user typed. After Enter, a quiet moment in its output calls `onSettled`: at once
 * when it follows the prompt coming back, and at most every `runningMs` while the command is still running. A command
 * that is silent for a while before it writes files is still reported when it ends; a shell that never marks its
 * prompt is reported as its output settles, at that same limited rate.
 */
export function commandSettleWatcher(onSettled: () => void, settleMs = COMMAND_SETTLE_MS, runningMs = RUNNING_SETTLE_MS): CommandSettleWatcher {
  let ran = false;
  let promptSeen = false;
  let lastRunningSettle = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settle = (): void => {
    timer = undefined;
    if (promptSeen) {
      ran = false;
      promptSeen = false;
      onSettled();
      return;
    }
    if (Date.now() - lastRunningSettle < runningMs) return;
    lastRunningSettle = Date.now();
    onSettled();
  };
  return {
    input(data) {
      if (!data.includes("\r")) return;
      ran = true;
      promptSeen = false;
    },
    output(chunk) {
      if (!ran) return;
      if (chunk.includes(PROMPT_READY)) promptSeen = true;
      clearTimeout(timer);
      timer = setTimeout(settle, settleMs);
    },
    dispose() {
      clearTimeout(timer);
      timer = undefined;
      if (!ran) return;
      ran = false;
      onSettled();
    },
  };
}
