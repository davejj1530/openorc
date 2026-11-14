import { useState } from "react";
import type { Route } from "../lib/router";
import type { TeamChatRoute } from "../lib/team-chat-route";
import { useThreadTabs } from "../lib/thread-tabs";
import { TeamChatVisibility } from "../lib/team-chat-visibility";
import { ProtectedTeamChat } from "./ProtectedTeamChat";

export function RetainedTeamChat({ route }: { route: Route }) {
  const [kept, setKept] = useState<TeamChatRoute | null>(null);
  const tabs = useThreadTabs((state) => state.tabs);
  const visible = route.view === "team-chat";
  if (visible && kept !== route) setKept(route);
  const target = visible ? route : kept;
  const open =
    target && tabs.some(({ route }) => route.view === "team-chat" && route.accountId === target.accountId && route.spaceId === target.spaceId && route.conversationId === target.conversationId);
  if (!target || (!visible && !open)) return null;
  return (
    <TeamChatVisibility value={visible}>
      <ProtectedTeamChat target={target} />
    </TeamChatVisibility>
  );
}
