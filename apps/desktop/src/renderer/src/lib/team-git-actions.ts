import type { TeamActionAvailability, TeamConversation } from "@openorc/protocol";

type GitActions = Pick<NonNullable<TeamConversation["actions"]>, "commit" | "push" | "createPr">;

/** Old cached projections and failed ownership checks never authorize a workspace write. */
export function teamGitActions(team: boolean, runtime: { isPending: boolean; isError: boolean; data?: Pick<TeamConversation, "actions"> | null }): GitActions {
  let reason: string | null = null;
  if (team) {
    if (runtime.isError) reason = "Could not check team Git actions. Retry before changing its workspace.";
    else if (runtime.isPending) reason = "Checking team Git actions…";
    else if (!runtime.data?.actions) reason = "Team Git actions are unavailable. Refresh team status.";
  }
  const action = (key: keyof GitActions): TeamActionAvailability => {
    if (!team) return { allowed: true, reason: null };
    if (reason) return { allowed: false, reason };
    const value = runtime.data?.actions?.[key];
    return value?.allowed ? value : { allowed: false, reason: value?.reason ?? "This action is currently unavailable for the team." };
  };
  return { commit: action("commit"), push: action("push"), createPr: action("createPr") };
}
