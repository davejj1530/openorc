import { Menu } from "@base-ui/react/menu";
import { cloneElement, type ButtonHTMLAttributes, type ReactElement } from "react";
import { CoversPreview } from "../../lib/browser-preview";
import { useTaskOnlineScope } from "../../lib/task-online-query";
import { useTaskThreadAction, type TaskThreadAction } from "../../lib/task-thread-action";
import { taskThreadPlace, type TaskThreadPlace } from "../../lib/task-thread-place";
import { useRpcMutation } from "../../lib/client";
import { openThread } from "../../lib/router";
import type { OnlineTaskRef } from "@openorc/protocol";
import { floatingGround } from "../../lib/use-anchor-ground";
import { ArrowUpRight, MessageSquare } from "../icons";
import { menuItem, menuPopup } from "../menu";
import { Button, IconButton, Tooltip } from "../ui";

/** Opens the task's thread on this computer, in its project's folder here, and shows it. */
export function useOpenHere(reference: OnlineTaskRef) {
  const mutation = useRpcMutation("tasks.online.openHere");
  const open = async () => {
    const { threadId } = await mutation.mutateAsync({ spaceId: reference.spaceId, id: reference.id });
    openThread(threadId);
  };
  return { open, pending: mutation.isPending, error: mutation.error?.message ?? null };
}

/** Why its thread can't open now: its work runs on someone else's computer, or what keeps its cloud thread from opening. */
function placeReason(place: TaskThreadPlace, cloudReason: string | null): string | null {
  if (place.kind === "elsewhere") return `Its work runs on ${place.name}'s computer.`;
  return place.kind === "cloud" ? cloudReason : null;
}

/**
 * A team task's thread: opened where its work already runs, in its cloud thread or in the person's own on this
 * computer; refused while it runs on someone else's; and with none yet, on the person's computer or on OpenOrc Cloud,
 * as they choose.
 */
export function TaskThreadLink({ compact = false, ...input }: TaskThreadAction & { compact?: boolean }) {
  const cloud = useTaskThreadAction(input);
  const here = useOpenHere(input.reference);
  const { availability } = useTaskOnlineScope();
  const place = taskThreadPlace(input.task, availability?.accountId ?? null, availability?.computer === true);
  const reason = placeReason(place, cloud.reason);
  const pending = cloud.pending || here.pending;
  const trigger: ReactElement<ButtonHTMLAttributes<HTMLButtonElement>> = compact ? (
    <IconButton size="xs" aria-label={`Open thread for ${input.task.title}`} disabled={Boolean(reason) || pending} />
  ) : (
    <Button disabled={Boolean(reason) || pending} />
  );
  const face = compact ? (
    <MessageSquare size={14} />
  ) : (
    <>
      Open thread <ArrowUpRight size={13} />
    </>
  );
  const error = cloud.error ?? here.error;
  return (
    <span className="relative inline-flex items-center">
      <Tooltip label={reason ?? undefined}>
        {place.kind === "choose" ? (
          <Menu.Root>
            <Menu.Trigger render={trigger}>{face}</Menu.Trigger>
            <Menu.Portal>
              <CoversPreview />
              <Menu.Positioner sideOffset={6} align="end" className="z-40" collisionPadding={8}>
                <Menu.Popup ref={floatingGround} className={menuPopup}>
                  <Menu.Item className={menuItem} onClick={() => void here.open().catch(() => undefined)}>
                    <span className="flex-1">On my computer</span>
                  </Menu.Item>
                  <Menu.Item className={menuItem} disabled={Boolean(cloud.reason)} onClick={() => void cloud.open()}>
                    <span className="flex-1">On OpenOrc Cloud</span>
                  </Menu.Item>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        ) : (
          cloneElement(trigger, { onClick: () => void (place.kind === "here" ? here.open().catch(() => undefined) : cloud.open()) }, face)
        )}
      </Tooltip>
      {error ? (
        <span role="alert" className="absolute right-0 bottom-full z-20 mb-2 w-64 rounded-md bg-float-fill px-2.5 py-1.5 text-sm text-bad break-words">
          {error}
        </span>
      ) : null}
    </span>
  );
}
