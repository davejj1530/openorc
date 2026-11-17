import type { TeamOrclingCall } from "@openorc/protocol";
import { useRpc } from "../lib/client";
import { cn } from "../lib/cn";
import { useTeamChatContext } from "../lib/team-chat-context";
import { OrclingAvatar } from "./OrclingAvatar";
import { Tooltip } from "./ui";
import "../styles/team-chat-orcling.css";

/**
 * How the Orcling a message called is doing, under that message: answering, or that it couldn't. Its owner alone tries
 * again, with the reason on demand; an answered call says nothing here, since its answer follows.
 */
export function TeamChatCallLine({ call, self, onRetry }: { call: TeamOrclingCall | null; self: string; onRetry?: (call: TeamOrclingCall) => void }) {
  if (!call || call.state === "answered") return null;
  const answering = call.state === "pending" || call.state === "running";
  const owner = call.owner.id === self;
  return (
    <div className={cn("team-chat-call", !answering && "team-chat-call-failed")} role="status">
      <OrclingAvatar orcling={call} size={16} />
      <span>{answering ? `${call.name} is answering…` : `${call.name} couldn't answer`}</span>
      {!answering && owner && onRetry ? <RetryCall call={call} onRetry={onRetry} /> : null}
    </div>
  );
}

function RetryCall({ call, onRetry }: { call: TeamOrclingCall; onRetry: (call: TeamOrclingCall) => void }) {
  const scope = useTeamChatContext();
  const owned = useRpc("teamChat.orclingCall", { spaceId: scope?.spaceId ?? "", callId: call.id }, { enabled: Boolean(scope) });
  return (
    <Tooltip label={owned.data?.reason ?? "Try again"}>
      <button type="button" className="team-chat-call-retry" onClick={() => onRetry(call)}>
        Retry
      </button>
    </Tooltip>
  );
}
