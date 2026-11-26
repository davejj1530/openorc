import { Popover } from "@base-ui/react/popover";
import { WorkingMark } from "./StateMark";
import type { TeamChatPerson, TeamChatPins as PinsPage, TeamMessage } from "@openorc/protocol";
import { CoversPreview } from "../lib/browser-preview";
import type { TeamChatContextValue } from "../lib/team-chat-context";
import { answeredOf } from "@openorc/client";
import { answeredWords } from "../lib/team-chat-replies";
import { useTeamChatPins } from "../lib/team-chat-pins";
import { floatingGround } from "../lib/use-anchor-ground";
import { TeamChatActorFace } from "./TeamChatActorFace";
import { actorName } from "../lib/team-chat-actor";
import { Pin, PinOff } from "./icons";
import { Button, Tooltip } from "./ui";
import "../styles/team-chat-pins.css";

export interface TeamChatPinsProps {
  scope: TeamChatContextValue;
  conversationId: string;
  people: readonly TeamChatPerson[];
  /** Opens a pinned message in place. */
  onOpen(message: TeamMessage): void;
  /** Unpinning, for someone in the conversation; absent for a reader who hasn't joined. */
  onUnpin?: (message: TeamMessage) => void;
}

/** The conversation's pins, behind a pin in its heading that counts them. */
export function TeamChatPins({ scope, conversationId, people, onOpen, onUnpin }: TeamChatPinsProps) {
  const pins = useTeamChatPins(scope, conversationId, true);
  const count = pins.data?.pins.length ?? 0;
  return (
    <Popover.Root>
      <Tooltip label="Pinned messages">
        <Popover.Trigger className="team-chat-pins-button" aria-label={count ? `Pinned messages, ${count}` : "Pinned messages"}>
          <Pin size={14} />
          {count ? <span>{count}</span> : null}
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <CoversPreview />
        <Popover.Positioner side="bottom" align="end" sideOffset={6} collisionPadding={8} className="z-50">
          <Popover.Popup ref={floatingGround} className="floating-popover team-chat-pins" aria-label="Pinned messages">
            <div className="floating-popover-title">Pinned messages</div>
            <PinsBody
              pending={pins.isPending}
              error={pins.error?.message ?? null}
              pinned={pins.data?.pins ?? []}
              onRetry={() => void pins.refetch()}
              people={people}
              onOpen={onOpen}
              onUnpin={onUnpin}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * What the popover shows, read while the heading draws: the query's state is read here, not handed down, so a failed
 * read redraws the heading and the popover opened after it shows the failure.
 */
function PinsBody({
  pending,
  error,
  pinned,
  onRetry,
  people,
  onOpen,
  onUnpin,
}: { pending: boolean; error: string | null; pinned: PinsPage["pins"]; onRetry(): void } & Pick<TeamChatPinsProps, "people" | "onOpen" | "onUnpin">) {
  if (pending)
    return (
      <div className="team-chat-pins-state" role="status">
        <WorkingMark size={14} />
      </div>
    );
  if (error)
    return (
      <div className="team-chat-pins-state" role="status">
        <p>{error}</p>
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  if (!pinned.length) return <p className="team-chat-pins-state">No pinned messages</p>;
  return (
    <ul className="team-chat-pins-list">
      {pinned.map(({ message }) => (
        <li key={message.id} className="team-chat-pin">
          <Popover.Close className="team-chat-pin-open" onClick={() => onOpen(message)}>
            <TeamChatActorFace actor={message.actor} size={20} />
            <span className="team-chat-pin-text">
              <span className="team-chat-pin-name">{actorName(message.actor)}</span>
              <span className="team-chat-pin-words">{answeredWords(answeredOf(message), people)}</span>
            </span>
          </Popover.Close>
          {onUnpin ? (
            <Tooltip label="Unpin">
              <button type="button" className="team-chat-pin-unpin" aria-label="Unpin" onClick={() => onUnpin(message)}>
                <PinOff size={14} />
              </button>
            </Tooltip>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
