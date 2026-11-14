import { teamChatRoster } from "@openorc/client";
import { useTeamChatContext } from "../lib/team-chat-context";
import { useTeamChatState } from "../lib/team-chat-queries";
import { useOpenTeamChat } from "../lib/team-chat-open";
import { useRouter } from "../lib/router";
import { SidebarChat } from "./SidebarChat";

/** The sidebar entry waits for the account's authorized capability and roster. */
export function OrganizationChat() {
  const scope = useTeamChatContext();
  const state = useTeamChatState();
  const route = useRouter((s) => s.route);
  const action = useOpenTeamChat();
  if (!scope || state.data?.state === "unavailable") return null;
  if (state.data?.state !== "ready")
    return state.error ? (
      <SidebarChat
        rows={[]}
        self={scope.accountId}
        selected={null}
        opening={null}
        error={state.error.message}
        onOpen={() => {}}
        onRetry={() => {
          void state.refetch();
        }}
      />
    ) : null;
  return (
    <SidebarChat
      rows={teamChatRoster(state.data.chat, scope.accountId)}
      self={scope.accountId}
      selected={route.view === "team-chat" ? route.conversationId : null}
      opening={action.opening}
      error={action.error}
      onOpen={(row) => {
        void action.open(row);
      }}
      onRetry={() => {
        void action.retry();
      }}
    />
  );
}
