import { Command } from "cmdk";
import { teamChatRoster, type TeamChatRow } from "@openorc/client";
import { useTeamChatContext } from "../lib/team-chat-context";
import { useTeamChatState } from "../lib/team-chat-queries";
import { useOpenTeamChat } from "../lib/team-chat-open";
import { TeamChatFace, TeamConversationFace } from "./TeamChatFace";

export function TeamChatPalette({ onOpened }: { onOpened(): void }) {
  const scope = useTeamChatContext();
  const state = useTeamChatState();
  const action = useOpenTeamChat();
  if (!scope || state.data?.state !== "ready") return null;
  const open = (row: TeamChatRow) => {
    void action.open(row).then((opened) => {
      if (opened) onOpened();
    });
  };
  return (
    <Command.Group heading="Chat" className="command-palette-group">
      {teamChatRoster(state.data.chat, scope.accountId).map((row) => (
        <Command.Item key={`${row.kind}:${row.id}`} value={`chat ${row.title}`} className="command-palette-item" aria-busy={action.opening === row.id || undefined} onSelect={() => open(row)}>
          <span className="command-palette-icon">
            {row.kind === "person" ? <TeamChatFace people={[row.person]} /> : <TeamConversationFace conversation={row.conversation} self={scope.accountId} />}
          </span>
          <span className="command-palette-label">{row.title}</span>
        </Command.Item>
      ))}
      {action.error ? (
        <div role="status" className="sidebar-chat-error">
          <span>{action.error}</span>{" "}
          <button
            type="button"
            onClick={() => {
              void action.retry().then((opened) => {
                if (opened) onOpened();
              });
            }}
          >
            Try again
          </button>
        </div>
      ) : null}
    </Command.Group>
  );
}
