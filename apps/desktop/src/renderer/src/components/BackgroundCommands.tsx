import type { BackgroundCommand } from "@openorc/protocol";
import { Terminal } from "./icons";
import { Button } from "./ui";

/** Commands the agent left running, such as a dev server. They outlive its turns, so each has its own stop. */
export function BackgroundCommands({ commands, pending, onStop }: { commands: BackgroundCommand[]; pending: boolean; onStop: (commandId: string) => void }) {
  if (!commands.length) return null;
  return (
    <ul aria-label="Running in the background" data-plane className="m-0 list-none divide-y divide-line rounded-xl bg-surface px-3.5 text-base">
      {commands.map((command) => (
        <li key={command.id} className="flex min-h-11 min-w-0 items-center gap-2 py-1.5 text-ink-4">
          <Terminal size={16} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink" title={command.description}>
            {command.description}
          </span>
          <span className="text-xs">Running</span>
          <Button size="sm" variant="ghost" disabled={pending} aria-label={`Stop ${command.description}`} onClick={() => onStop(command.id)}>
            Stop
          </Button>
        </li>
      ))}
    </ul>
  );
}
