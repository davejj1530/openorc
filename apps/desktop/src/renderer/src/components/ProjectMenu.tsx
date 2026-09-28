import { useState, type ReactNode } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "@base-ui/react/menu";
import { WORKSPACE_ID } from "@openorc/protocol";
import { CoversPreview } from "../lib/browser-preview";
import { useLayout } from "../lib/layout";
import { useRpcMutation } from "../lib/query";
import { MoreHorizontal, X } from "./icons";
import { menuItem, menuPopup } from "./ThreadActions";
import { Button, Dialog, IconButton, Tooltip } from "./ui";

export const projectHeadingClassName = "flex items-center gap-1 h-8 pl-1 pr-1";

/** Both the context menu and options button share one removal flow. */
export function ProjectMenu({ project, children }: { project: { id: string; name: string }; children: ReactNode }) {
  const [confirm, setConfirm] = useState(false);
  const requestRemoval = () => setConfirm(true);
  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger className={projectHeadingClassName}>
          {children}
          <Menu.Root>
            <Tooltip label={`Project options for ${project.name}`}>
              <Menu.Trigger render={<IconButton aria-label={`Project options for ${project.name}`} size="sm" className="sidebar-project-add no-drag data-[popup-open]:opacity-100" />}>
                <MoreHorizontal size={14} />
              </Menu.Trigger>
            </Tooltip>
            <Menu.Portal>
              <CoversPreview />
              <Menu.Positioner sideOffset={4} align="end" collisionPadding={8} className="z-40">
                <Menu.Popup className={menuPopup}>
                  <Menu.Item className={menuItem} onClick={requestRemoval}>
                    <X size={13} /> Remove project…
                  </Menu.Item>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <CoversPreview />
          <ContextMenu.Positioner collisionPadding={8} className="z-40">
            <ContextMenu.Popup className={menuPopup}>
              <ContextMenu.Item className={menuItem} onClick={requestRemoval}>
                <X size={13} /> Remove project…
              </ContextMenu.Item>
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {confirm ? <RemoveProjectDialog project={project} onClose={() => setConfirm(false)} /> : null}
    </>
  );
}

function RemoveProjectDialog({ project, onClose }: { project: { id: string; name: string }; onClose: () => void }) {
  const remove = useRpcMutation("projects.remove");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !remove.isPending) onClose();
      }}
      title="Remove project?"
    >
      <p className="text-base text-ink-2 break-words">
        Remove <span className="font-medium text-ink">{project.name}</span> from the Projects list? Files, worktrees, and history are kept. Add the folder again to bring it back.
      </p>
      <p className="mt-2 text-base text-ink-3">Running work and schedules will continue.</p>
      {remove.error ? (
        <p role="alert" className="mt-3 text-base text-bad break-words">
          {remove.error.message}
        </p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" disabled={remove.isPending} onClick={() => onClose()}>
          Cancel
        </Button>
        <Button
          disabled={remove.isPending}
          onClick={() =>
            remove.mutate(
              { id: project.id },
              {
                onSuccess: () => {
                  const layout = useLayout.getState();
                  if (layout.projectId === project.id) layout.setProject(WORKSPACE_ID);
                  onClose();
                },
              },
            )
          }
        >
          {remove.isPending ? "Removing…" : "Remove project"}
        </Button>
      </div>
    </Dialog>
  );
}
