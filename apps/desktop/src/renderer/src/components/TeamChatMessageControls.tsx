import { ContextMenu } from "@base-ui/react/context-menu";
import type { TeamMessage } from "@openorc/protocol";
import { CornerUpLeft, Copy, Pin, PinOff, SmilePlus } from "./icons";
import { menuItem } from "./menu";
import { Tooltip } from "./ui";

interface Controls {
  /** Why reacting is held, or null. */
  reason: string | null;
  /** Answering the message from the composer; absent where replies aren't available. */
  onReply?: () => void;
}

/** A pinned message's mark at its bubble's lower outer corner; who pinned it is said on demand. */
export function TeamChatPinnedMark({ pinned }: { pinned: TeamMessage["pinned"] }) {
  if (!pinned) return null;
  return (
    <Tooltip label={`Pinned by ${pinned.by?.name ?? "a former member"}`}>
      <span className="team-chat-pinned-mark" role="img" aria-label={`Pinned by ${pinned.by?.name ?? "a former member"}`}>
        <Pin size={12} />
      </span>
    </Tooltip>
  );
}

/** What a message's menu offers. */
export function TeamChatMessageMenuItems({ reason, onReply, onCopy, onReact, pinned, onPin }: Controls & { onCopy(): void; onReact(): void; pinned: boolean; onPin?: (pinned: boolean) => void }) {
  return (
    <>
      <ContextMenu.Item className={menuItem} onClick={onCopy}>
        <Copy size={14} />
        Copy text
      </ContextMenu.Item>
      {onReply ? (
        <ContextMenu.Item className={menuItem} onClick={onReply}>
          <CornerUpLeft size={14} />
          Reply
        </ContextMenu.Item>
      ) : null}
      <Tooltip label={reason ?? "React"}>
        <ContextMenu.Item className={menuItem} disabled={Boolean(reason)} onClick={onReact}>
          <SmilePlus size={14} />
          React
        </ContextMenu.Item>
      </Tooltip>
      {onPin ? (
        <Tooltip label={reason ?? (pinned ? "Unpin" : "Pin")}>
          <ContextMenu.Item className={menuItem} disabled={Boolean(reason)} onClick={() => onPin(!pinned)}>
            {pinned ? <PinOff size={14} /> : <Pin size={14} />}
            {pinned ? "Unpin" : "Pin"}
          </ContextMenu.Item>
        </Tooltip>
      ) : null}
    </>
  );
}

/** The round buttons beside a bubble, there while it is pointed at or focused: React, then Reply. */
export function TeamChatMessageActions({ reason, onReply, reacting, onReacting }: Controls & { reacting: boolean; onReacting(open: boolean): void }) {
  return (
    <div className="team-chat-message-actions">
      <Tooltip label={reason ?? "React"}>
        <button type="button" className="orcling-react-open" aria-label="React" aria-expanded={reacting} disabled={Boolean(reason)} onClick={() => onReacting(!reacting)}>
          <SmilePlus size={16} />
        </button>
      </Tooltip>
      {onReply ? (
        <Tooltip label="Reply">
          <button type="button" className="orcling-react-open" aria-label="Reply" onClick={onReply}>
            <CornerUpLeft size={16} />
          </button>
        </Tooltip>
      ) : null}
    </div>
  );
}
