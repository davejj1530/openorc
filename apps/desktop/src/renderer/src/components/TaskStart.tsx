import type { Task } from "@openorc/protocol";
import { Loader2, MessageSquare } from "./icons";
import { IconButton, Tooltip } from "./ui";
import { useRpcMutation } from "../lib/client";
import { openThread, useRouter } from "../lib/router";

/** A task links to a conversation; opening it never launches an agent. */
export function TaskStart({ task }: { task: Task }) {
  const conversation = useRpcMutation("tasks.openThread");
  return (
    <div className="relative flex shrink-0 items-center" onKeyDown={(event) => event.stopPropagation()}>
      <Tooltip label={conversation.isPending ? "Opening thread…" : "Open thread"}>
        <IconButton
          size="xs"
          aria-label={`Open thread for ${task.title}`}
          disabled={conversation.isPending}
          onClick={async () => {
            const route = useRouter.getState().route;
            try {
              const thread = await conversation.mutateAsync({ taskId: task.id });
              if (useRouter.getState().route === route) openThread(thread.id);
            } catch {
              /* The mutation retains the error for retry. */
            }
          }}
        >
          {conversation.isPending ? <Loader2 size={14} className="animate-spin" /> : <MessageSquare size={14} />}
        </IconButton>
      </Tooltip>
      {conversation.error ? (
        <p role="alert" className="absolute right-0 top-full z-20 mt-1 w-56 rounded-md bg-float-fill px-2.5 py-1.5 text-sm text-bad break-words">
          {conversation.error.message}
        </p>
      ) : null}
    </div>
  );
}
