import type { BackgroundCommand } from "@openorc/protocol";
import { Terminal } from "./icons";
import { Button } from "./ui";
import { useComposerControl } from "./composer-read-only";

/**
 * Commands the agent left running, such as a dev server. They outlive its turns, so each has its own stop. `canStop` is
 * the server's word on whether this reader stops them, where it has one: a handoff that holds the reader's turn does
 * not hold the Stop it asks for. Otherwise the composer's own rule decides.
 */
export function BackgroundCommands({ commands, pending, canStop, onStop }: { commands: BackgroundCommand[]; pending: boolean; canStop?: boolean | undefined; onStop: (commandId: string) => void }) {
  const composer = useComposerControl(pending);
  const control = canStop === true ? { disabled: pending, reason: undefined } : composer;
  if (!commands.length) return null;
  return (
    <ul aria-label="Running in the background" data-plane className="m-0 list-none divide-y divide-line rounded-xl bg-surface px-3.5 text-base">
      {commands.map((command) => (
        <li key={command.id} className="flex min-h-11 min-w-0 items-center gap-2 py-1.5 text-ink-4">
          <Terminal size={16} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink" data-tip={command.description}>
            {command.description}
          </span>
          <span className="text-xs">Running</span>
          <Button size="sm" variant="ghost" disabled={control.disabled} data-tip={control.reason} aria-label={`Stop ${command.description}`} onClick={() => onStop(command.id)}>
            Stop
          </Button>
        </li>
      ))}
    </ul>
  );
}
