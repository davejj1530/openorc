import { useState, type ReactNode } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { WORKSPACE_ID } from "@openorc/protocol";
import { CoversPreview } from "../lib/browser-preview";
import { useLayout } from "../lib/layout";
import { useRpcMutation } from "../lib/query";
import { X } from "./icons";
import { menuItem, menuPopup } from "./ThreadActions";
import { Button, Dialog } from "./ui";

export const projectHeadingClassName = "flex items-center gap-1 h-8 pl-1 pr-1";

/** Project removal lives in the heading's context menu. */
export function ProjectMenu({ project, children }: { project: { id: string; name: string }; children: ReactNode }) {
  const [confirm, setConfirm] = useState(false);
  const requestRemoval = () => setConfirm(true);
  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger
          className={projectHeadingClassName}
          onKeyDown={(event) => {
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
            event.preventDefault();
            // macOS does not emit a contextmenu event for the keyboard shortcut.
            const { left, bottom } = event.currentTarget.getBoundingClientRect();
            event.currentTarget.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: left, clientY: bottom }));
          }}
        >
          {children}
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
