import type { Route } from "./router";

export interface TeamChatRoute {
  view: "team-chat";
  accountId: string;
  spaceId: string;
  conversationId: string;
}
export type ChatWorkRoute = Extract<Route, { view: "thread" | "newthread" }>;
interface Navigation {
  route: Route;
  threadIds: string[];
  chatWork: ChatWorkRoute | null;
}

/** Chat suspends the current work; a different space can never inherit it. */
export function chatRouteTransition(state: Navigation, route: Route): Navigation | null {
  if (route.view === "team-chat") {
    const sameSpace = state.route.view === "team-chat" && state.route.accountId === route.accountId && state.route.spaceId === route.spaceId;
    let work = sameSpace ? state.chatWork : null;
    if (state.route.view === "thread" || state.route.view === "newthread") work = state.route;
    return { route, threadIds: work?.view === "thread" ? state.threadIds : [], chatWork: work };
  }
  if (state.route.view !== "team-chat" || !state.chatWork) return null;
  if (route.view === "thread" && state.threadIds.includes(route.threadId)) {
    return { route: route.threadId === state.threadIds[0] ? state.chatWork : route, threadIds: state.threadIds, chatWork: null };
  }
  return null;
}

export function chatRouteFromSpec(spec: string): TeamChatRoute | null {
  try {
    const [view, accountId, spaceId, conversationId, extra] = spec.split(":").map(decodeURIComponent);
    return view === "team-chat" && accountId && spaceId && conversationId && extra === undefined ? { view, accountId, spaceId, conversationId } : null;
  } catch {
    return null;
  }
}
export function chatRouteSpec(route: TeamChatRoute): string {
  return [route.view, route.accountId, route.spaceId, route.conversationId].map(encodeURIComponent).join(":");
}
