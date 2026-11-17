import type { RpcParams, TeamChatRpcResults } from "@openorc/protocol";
import type { TeamChat } from "./chat.js";

export type TeamChatMethod = keyof TeamChatRpcResults;
export type TeamChatCalls = { [M in TeamChatMethod]: (params: RpcParams<M>) => Promise<TeamChatRpcResults[M]> | TeamChatRpcResults[M] };

/** Who runs the person's own Orcling for a message that calls it: the app holding that Orcling. */
export interface TeamChatOrclingRunner {
  send(input: RpcParams<"teamChat.send">, chat: TeamChat): Promise<TeamChatRpcResults["teamChat.send"]>;
  retry(input: RpcParams<"teamChat.retryOrclingCall">, chat: TeamChat): Promise<TeamChatRpcResults["teamChat.retryOrclingCall"]>;
}

/** A call that runs an Orcling, which only the app holding it can answer: a phone sends it to its Mac. */
export function runsOrcling(method: TeamChatMethod, params: Record<string, unknown>): boolean {
  return method === "teamChat.retryOrclingCall" || (method === "teamChat.send" && params["orcling"] !== undefined);
}

/** Every team chat call, answered by one account's chat; a message calling an Orcling goes through its runner. */
export function teamChatCalls(chat: TeamChat | null, runner: TeamChatOrclingRunner): TeamChatCalls {
  const requireChat = (): TeamChat => {
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
    "teamChat.send": (input) => runner.send(input, requireChat()),
    "teamChat.orclingCall": (input) => requireChat().orclingCall(input),
    "teamChat.presence": (input) => requireChat().presence(input),
    "teamChat.retryOrclingCall": (input) => runner.retry(input, requireChat()),
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

/** For an app that holds no Orclings: a message is sent as words alone, and nothing here can run a call. */
export const noOrclingRunner: TeamChatOrclingRunner = {
  send: ({ orcling, ...message }, chat) => {
    if (orcling) return Promise.reject(new Error("Call your Orcling from the Mac it lives on."));
    return chat.send(message);
  },
  retry: () => Promise.reject(new Error("Try the call again from the Mac its Orcling lives on.")),
};

const teamChatMethods: ReadonlySet<string> = new Set(Object.keys(teamChatCalls(null, noOrclingRunner)));
export const isTeamChatMethod = (method: string): method is TeamChatMethod => teamChatMethods.has(method);
