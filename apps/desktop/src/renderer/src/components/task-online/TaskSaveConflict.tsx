import type { OnlineTask } from "@openorc/protocol";
import { Button } from "../ui";

export function TaskSaveConflict({ current, pending, useSaved, saveMine }: { current: OnlineTask; pending: boolean; useSaved(): void; saveMine(): void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" role="status">
      <span className="text-ink-2">{current.updatedBy ? `${current.updatedBy.name} updated this task.` : "This task was updated."}</span>
      <Button size="sm" disabled={pending} onClick={useSaved}>
        Use saved version
      </Button>
      <Button size="sm" disabled={pending} onClick={saveMine}>
        Save my changes
      </Button>
    </div>
  );
}
