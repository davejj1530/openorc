import { useTaskThreadAction, type TaskThreadAction } from "../../lib/task-thread-action";
import { ArrowUpRight, MessageSquare } from "../icons";
import { Button, IconButton, Tooltip } from "../ui";

export function TaskThreadLink({ compact = false, ...input }: TaskThreadAction & { compact?: boolean }) {
  const action = useTaskThreadAction(input);
  const disabled = Boolean(action.reason) || action.pending;
  return (
    <span className="relative inline-flex items-center">
      <Tooltip label={action.reason ?? undefined}>
        {compact ? (
          <IconButton size="xs" aria-label={`Open thread for ${input.task.title}`} disabled={disabled} onClick={() => void action.open()}>
            <MessageSquare size={14} />
          </IconButton>
        ) : (
          <Button disabled={disabled} onClick={() => void action.open()}>
            Open thread <ArrowUpRight size={13} />
          </Button>
        )}
      </Tooltip>
      {action.error ? (
        <span role="alert" className="absolute right-0 bottom-full z-20 mb-2 w-64 rounded-md bg-float-fill px-2.5 py-1.5 text-sm text-bad break-words">
          {action.error}
        </span>
      ) : null}
    </span>
  );
}
