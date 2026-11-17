import { createTeamChat, type TeamChatLease, type TeamChatTarget } from "@openorc/client";
import { core } from "./rpc";
import { queryClient } from "./client";
import { useTeamChatContext } from "./team-chat-context";

/** This window's team chat: the shared stores over its port to the core, with drafts in its local storage. */
export const teamChat = createTeamChat({ connection: core, queryClient, storage: localStorage, randomId: () => crypto.randomUUID() });
export const teamChatDrafts = teamChat.drafts;
export const chatStateKey = teamChat.keys.state;
export const chatTimelineKey = teamChat.keys.timeline;
export const receiveTeamMessage = teamChat.receive;
export const useTeamChatTimeline = teamChat.useTimeline;
export const useTeamChatWatch = teamChat.useWatch;
export const earlierTeamMessages = (scope: TeamChatLease, target: TeamChatTarget) => teamChat.earlier(scope, target.conversationId);

/** The chat of the organization this window shows, under its lease. */
export const useTeamChatState = () => teamChat.useChatState(useTeamChatContext());
