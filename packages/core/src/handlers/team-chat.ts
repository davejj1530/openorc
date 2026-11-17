import type { TeamChatRpcResults } from "@openorc/protocol";
import type { Hosted } from "@openorc/hosted";
import type { TeamChatOrclingCalls } from "../services/team-chat-orclings.js";
import type { Handlers } from "./types.js";

type ChatCalls = Hosted["chat"];

/** These local calls never enter the paired-phone allowlist or the thread owner router. */
export function createTeamChatHandlers(chat: ChatCalls | null, orclings: TeamChatOrclingCalls): Pick<Handlers, keyof TeamChatRpcResults> {
  const requireChat = (): ChatCalls => {
    if (!chat) throw new Error("Chat isn't available here.");
    return chat;
  };
  return {
    "teamChat.state": (input) => chat?.state(input) ?? { state: "unavailable" },
    "teamChat.openDm": (input) => requireChat().openDm(input),
    "teamChat.conversation": (input) => requireChat().conversation(input),
    "teamChat.createChannel": (input) => requireChat().createChannel(input),
    "teamChat.joinChannel": (input) => requireChat().joinChannel(input),
    "teamChat.leaveChannel": (input) => requireChat().leaveChannel(input),
    "teamChat.addMembers": (input) => requireChat().addMembers(input),
    "teamChat.removeMember": (input) => requireChat().removeMember(input),
    "teamChat.timeline": (input) => requireChat().timeline(input),
    "teamChat.send": (input) => orclings.send(input, requireChat()),
    "teamChat.orclingCall": (input) => requireChat().orclingCall(input),
    "teamChat.retryOrclingCall": (input) => orclings.retry(input, requireChat()),
    "teamChat.react": (input) => requireChat().react(input),
    "teamChat.pins": (input) => requireChat().pins(input),
    "teamChat.pin": (input) => requireChat().pin(input),
    "teamChat.search": (input) => requireChat().search(input),
    "teamChat.watch": (input) => requireChat().watch(input),
    "teamChat.unwatch": (input) => chat?.unwatch(input) ?? {},
    "teamChat.seen": (input) => requireChat().seen(input),
    "teamChat.unreadSpaces": (input) => chat?.unreadSpaces(input) ?? { spaceIds: [] },
  };
}
