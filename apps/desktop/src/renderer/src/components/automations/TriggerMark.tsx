import type { AutomationTrigger } from "@openorc/protocol";
import { Eye, GitPullRequest, ListChecks } from "../icons";

/** The mark of what an automation waits for: a pull request, a task, or a check that watches for something. */
export function TriggerMark({ trigger, size = 16 }: { trigger: AutomationTrigger; size?: number }) {
  if (trigger.kind === "pull_request") return <GitPullRequest size={size} />;
  return trigger.kind === "check" ? <Eye size={size} /> : <ListChecks size={size} />;
}
