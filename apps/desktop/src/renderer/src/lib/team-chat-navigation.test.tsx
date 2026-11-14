import { beforeEach, expect, it } from "vitest";
import { useLayout } from "./layout";
import { routeFromSpec, specFromRoute, useRouter } from "./router";

const chat = { view: "team-chat" as const, accountId: "account", spaceId: "team", conversationId: "general" };
beforeEach(() => {
  useRouter.setState({ route: { view: "newthread" }, threadIds: [], history: [], future: [] });
  useLayout.setState({ panelThreadId: null, panelOpen: false, selectedFile: null });
});
it("returns from chat to the same focused split and open file", () => {
  const router = useRouter.getState();
  router.navigate({ view: "thread", threadId: "first" });
  router.addThreadPane("second");
  router.focusThreadPane("second");
  useLayout.getState().openFile({ path: "/tmp/example-project/src/main.ts", scope: { kind: "thread", id: "first" } });
  const before = useLayout.getState().selectedFile;
  router.navigate(chat);
  expect(useRouter.getState().threadIds).toEqual(["first", "second"]);
  expect(useLayout.getState().selectedFile).toEqual(before);
  router.show({ view: "thread", threadId: "first" });
  expect(useRouter.getState().route).toEqual({ view: "thread", threadId: "second" });
  expect(useRouter.getState().threadIds).toEqual(["first", "second"]);
  expect(useLayout.getState().selectedFile).toEqual(before);
});
it("keeps the People origin in Back and chat in Forward", () => {
  const router = useRouter.getState();
  router.navigate({ view: "people", spaceId: "team" });
  router.navigate(chat);
  router.back();
  expect(useRouter.getState().route).toEqual({ view: "people", spaceId: "team" });
  router.forward();
  expect(useRouter.getState().route).toEqual(chat);
});
it("never carries suspended work into another chat account or space", () => {
  const router = useRouter.getState();
  router.navigate({ view: "thread", threadId: "first" });
  router.navigate(chat);
  router.navigate({ ...chat, accountId: "other" });
  expect(useRouter.getState().threadIds).toEqual([]);
});
it("round trips only complete scoped chat links, including encoded ids", () => {
  const route = { ...chat, conversationId: "chat:one" };
  expect(routeFromSpec(specFromRoute(route))).toEqual(route);
  expect(routeFromSpec("team-chat:account:team")).toBeNull();
  expect(routeFromSpec("team-chat:account:team:%")).toBeNull();
});
