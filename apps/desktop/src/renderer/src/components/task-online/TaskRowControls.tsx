import { Menu } from "@base-ui/react/menu";
import type { OnlineTask, OnlineTaskRef } from "@openorc/protocol";
import { useTaskProperty } from "../../lib/task-property";
import { CoversPreview } from "../../lib/browser-preview";
import { floatingGround } from "../../lib/use-anchor-ground";
import { Check, MessageSquare } from "../icons";
import { menuItem, menuPopup } from "../menu";
import { StatusIcon, statusLabel, statusOrder } from "../status";
import { IconButton, Tooltip } from "../ui";

export function TaskOnlineRowStatus({ reference, task, onMoved }: { reference: OnlineTaskRef; task: OnlineTask; onMoved: () => void }) {
  const update = useTaskProperty(reference, task);
  const error = update.state.propertyError;
  return (
    <div className="task-row-status relative shrink-0">
      <Menu.Root>
        <Menu.Trigger
          render={<IconButton aria-label={`Status for ${task.title}`} size="xs" />}
          disabled={update.pending || !task.viewer.mayEdit}
          data-tip={task.viewer.mayEdit ? `Change status · ${statusLabel[task.status]}` : "You can’t edit this task."}
        >
          <StatusIcon status={task.status} />
        </Menu.Trigger>
        <Menu.Portal>
          <CoversPreview />
          <Menu.Positioner sideOffset={6} align="start" className="z-40" collisionPadding={8}>
            <Menu.Popup ref={floatingGround} className={menuPopup}>
              {statusOrder.map((status) => (
                <Menu.Item
                  key={status}
                  className={menuItem}
                  onClick={() => {
                    if (status === task.status) return;
                    void update.controller.property({ status }).then(onMoved);
                  }}
                >
                  <StatusIcon status={status} />
                  <span className="flex-1">{statusLabel[status]}</span>
                  {status === task.status ? <Check size={13} className="text-ink-3" /> : null}
                </Menu.Item>
              ))}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {error ? (
        <p role="alert" className="absolute left-0 top-full z-20 mt-1 w-56 rounded-md bg-float-fill px-2.5 py-1.5 text-sm text-bad break-words">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function TaskOnlineOpen({ task }: { task: OnlineTask }) {
  return (
    <Tooltip label={task.execution.state === "unavailable" ? "This task’s thread is unavailable." : "Opening cloud task threads isn’t available yet."}>
      <IconButton size="xs" aria-label={`Open thread for ${task.title}`} disabled>
        <MessageSquare size={14} />
      </IconButton>
    </Tooltip>
  );
}
