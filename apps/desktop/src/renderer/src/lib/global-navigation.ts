import type { Orcling, OrclingGroup } from "@openorc/protocol";
import { queryClient } from "./client";
import type { Route } from "./router";

/** Person-level destinations leave each space's last project-work destination intact. */
export function globalDestination(route: Route): boolean {
  if (["settings", "onboarding", "orcling"].includes(route.view)) return true;
  if (route.view !== "thread") return false;
  const orclings = queryClient.getQueryData<Orcling[]>(["orclings.list", {}]) ?? [];
  const groups = queryClient.getQueryData<OrclingGroup[]>(["orclings.groups.list", {}]) ?? [];
  return [...orclings, ...groups].some((chat) => chat.threadId === route.threadId);
}
