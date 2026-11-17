import { teamChat } from "./team-chat-queries";

/** The account's organizations with unread chat, for the switcher's one neutral mark; focus repairs a missed invalidation. */
export const useUnreadChatSpaces = teamChat.useUnreadSpaces;
