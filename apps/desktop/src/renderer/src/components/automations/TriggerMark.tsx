import type { AutomationTrigger } from "@openorc/protocol";
import { Code2, Eye, GitPullRequest, ListChecks } from "../icons";

/** The mark of what an automation waits for: a pull request, a task, or a check that watches for something. */
export function TriggerMark({ trigger, size = 16 }: { trigger: AutomationTrigger; size?: number }) {
  if (trigger.kind === "pull_request") return <GitPullRequest size={size} />;
  if (trigger.kind === "program") return <Code2 size={size} />;
  return trigger.kind === "check" ? <Eye size={size} /> : <ListChecks size={size} />;
}
