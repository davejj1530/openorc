import { teamChatCallLine } from "@openorc/client";
import type { TeamOrclingCall } from "@openorc/protocol";
import { cn } from "../lib/cn";
import { useTeamChatContext } from "../lib/team-chat-context";
import { teamChat } from "../lib/team-chat-queries";
import { OrclingAvatar } from "./OrclingAvatar";
import { Tooltip } from "./ui";
import "../styles/team-chat-orcling.css";

/**
 * How the Orcling a message called is doing, under that message: answering, or that it couldn't. Its owner alone tries
 * again, with the reason on demand; an answered call says nothing here, since its answer follows.
 */
export function TeamChatCallLine({ call, self, onRetry }: { call: TeamOrclingCall | null; self: string; onRetry?: (call: TeamOrclingCall) => void }) {
  const line = teamChatCallLine(call, self);
  if (!call || !line) return null;
  return (
    <div className={cn("team-chat-call", line.failed && "team-chat-call-failed")} role="status">
      <OrclingAvatar orcling={call} size={16} />
      <span>{line.words}</span>
      {line.canRetry && onRetry ? <RetryCall call={call} self={self} onRetry={onRetry} /> : null}
    </div>
  );
}

function RetryCall({ call, self, onRetry }: { call: TeamOrclingCall; self: string; onRetry: (call: TeamOrclingCall) => void }) {
  const owned = teamChat.useOwnerCall(useTeamChatContext(), call, self);
  return (
    <Tooltip label={owned.data?.reason ?? "Try again"}>
      <button type="button" className="team-chat-call-retry" onClick={() => onRetry(call)}>
        Retry
      </button>
    </Tooltip>
  );
}
