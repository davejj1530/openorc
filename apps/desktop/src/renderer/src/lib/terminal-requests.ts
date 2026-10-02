import { create } from "zustand";
import { COMMAND_SETTLE_MS, PROMPT_READY } from "../../../shared/command-settle";
import { useLayout } from "./layout";

/** Commands waiting to be typed into a panel shell, by that shell's id. Each is typed once, so none is persisted. */
const useRequests = create<{ commands: Record<string, string> }>(() => ({ commands: {} }));

function takeCommand(id: string): string | null {
  const command = useRequests.getState().commands[id];
  if (command === undefined) return null;
  useRequests.setState((s) => ({ commands: Object.fromEntries(Object.entries(s.commands).filter(([key]) => key !== id)) }));
  return command;
}

/**
 * Opens the Terminal tab of a thread or task and types `command` into the shell it shows there, which the panel keys
 * by the same scope.
 */
export function runInTerminal(scope: { kind: "thread" | "task"; id: string }, command: string): void {
  const id = `${scope.kind}:${scope.id}`;
  useRequests.setState((s) => ({ commands: { ...s.commands, [id]: command } }));
  const layout = useLayout.getState();
  layout.rememberPanelTool(id, "terminal");
  if (scope.kind === "thread") layout.openThreadPanel(scope.id, "terminal");
  else layout.setPanel(true, "terminal");
}

export interface PromptTyping {
  /** Output the shell wrote, the backlog of one already running included. */
  output(chunk: string): void;
  /** The shell ended: what is asked for now waits for the next one. */
  ended(): void;
  dispose(): void;
}

/**
 * Types each command asked for shell `id` once the shell is at a prompt. Typed any sooner, the terminal shows it
 * once before the prompt and again on it. A shell that never marks its prompt is taken to be at one once its output
 * goes quiet.
 */
export function typeAtPrompt(id: string, type: (command: string) => void): PromptTyping {
  let atPrompt = false;
  let quiet: ReturnType<typeof setTimeout> | undefined;
  const typeRequested = (): void => {
    if (!atPrompt) return;
    const command = takeCommand(id);
    if (command !== null) type(command);
  };
  const promptShown = (): void => {
    atPrompt = true;
    typeRequested();
  };
  const unsubscribe = useRequests.subscribe(typeRequested);
  return {
    output(chunk) {
      if (atPrompt) return;
      clearTimeout(quiet);
      if (chunk.includes(PROMPT_READY)) promptShown();
      else quiet = setTimeout(promptShown, COMMAND_SETTLE_MS);
    },
    ended() {
      atPrompt = false;
    },
    dispose() {
      clearTimeout(quiet);
      unsubscribe();
    },
  };
}
