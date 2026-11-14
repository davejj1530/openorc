import type { RpcParams, TeamChatRpcResults } from "@openorc/protocol";
import type { Handlers } from "./types.js";

type ChatCalls = {
  [Method in keyof TeamChatRpcResults as Method extends `teamChat.${infer Name}` ? Name : never]: (input: RpcParams<Method>) => Promise<TeamChatRpcResults[Method]>;
};

/** These local calls never enter the paired-phone allowlist or the thread owner router. */
export function createTeamChatHandlers(chat: ChatCalls | null): Pick<Handlers, keyof TeamChatRpcResults> {
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
    "teamChat.send": (input) => requireChat().send(input),
    "teamChat.react": (input) => requireChat().react(input),
    "teamChat.watch": (input) => requireChat().watch(input),
    "teamChat.unwatch": (input) => chat?.unwatch(input) ?? {},
  };
}
