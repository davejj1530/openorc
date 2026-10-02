import type { BackgroundCommand } from "@openorc/protocol";
import { Terminal } from "./icons";
import { Button } from "./ui";

/** Commands the agent left running, such as a dev server. They outlive its turns, so each has its own stop. */
export function BackgroundCommands({ commands, pending, onStop }: { commands: BackgroundCommand[]; pending: boolean; onStop: (commandId: string) => void }) {
  if (!commands.length) return null;
  return (
    <ul aria-label="Running in the background" className="m-0 list-none divide-y divide-line rounded-lg border border-line px-3 text-sm">
      {commands.map((command) => (
        <li key={command.id} className="flex min-w-0 items-center gap-2 py-1.5 text-ink-3">
          <Terminal size={14} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate text-ink-2" title={command.description}>
            {command.description}
          </span>
          <span>Running</span>
          <Button size="sm" variant="ghost" disabled={pending} aria-label={`Stop ${command.description}`} onClick={() => onStop(command.id)}>
            Stop
          </Button>
        </li>
      ))}
    </ul>
  );
}
