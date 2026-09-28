import { useState } from "react";
import { executionModeAvailable, executionModePresentation, type PermissionPreset, type ThreadSummary } from "@openorc/protocol";
import { useRpcMutation } from "../lib/query";
import { useConversationPlans } from "../lib/conversation-plans";
import { Button, Input, Select, TextButton } from "./ui";
import { RichText } from "./RichText";

function revisionStateSuffix(state: string): string {
  if (state === "draft") return " · writing";
  if (state === "interrupted") return " · interrupted";
  return "";
}

/** Plan content has its own subscription so streaming it doesn't re-render the transcript. */
export function ConversationPlan({ thread }: { thread: ThreadSummary }) {
  const team = Boolean(thread.teamInstanceId);
  const { query, runtime, plans } = useConversationPlans(thread.id, team);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [chosenPermission, setPermission] = useState<PermissionPreset>("review");
  const [exporting, setExporting] = useState(false);
  const [filename, setFilename] = useState("openorc-plan.md");
  const implement = useRpcMutation("threads.implementPlan");
  const implementTeam = useRpcMutation("orchestration.implementPlan");
  const exportPlan = useRpcMutation("threads.exportPlan");
  const plan = plans.find((p) => p.id === selectedId) ?? plans[0];
  // Offer only what this agent can run, starting from the strictest of those.
  const implementationModes = (["review", "trusted", "autonomous"] as const).filter((mode) => executionModeAvailable(thread.agent, mode));
  const permission = implementationModes.includes(chosenPermission) ? chosenPermission : (implementationModes[0] ?? chosenPermission);
  const ready = plan?.state === "ready" && Boolean(plan.text.trim());
  const current = plan?.id === plans[0]?.id;
  const busy = team
    ? !runtime.data ||
      runtime.data.executions.some((execution) => !["completed", "stopped"].includes(execution.state) && execution.actors.some((actor) => actor.state === "running" || actor.state === "starting"))
    : thread.activity !== "idle";
  const implementing = implement.isPending || implementTeam.isPending;
  const error = implement.error ?? implementTeam.error ?? exportPlan.error;
  return (
    <section className="h-full min-w-0 flex min-h-0 flex-col" aria-label="Conversation plan">
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="text-sm font-medium text-ink">{team ? "Team plan" : "Conversation plan"}</span>
        <span className="flex-1" />
        {plan ? (
          <Select aria-label="Plan revision" value={plan.id} onChange={(e) => setSelectedId(e.target.value)}>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                Revision {p.revision}
                {revisionStateSuffix(p.state)}
              </option>
            ))}
          </Select>
        ) : null}
      </header>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto p-4 text-sm">
        {query.error ? (
          <p role="alert">
            {query.error.message}
            <TextButton onClick={() => void query.refetch()}>Retry</TextButton>
          </p>
        ) : null}
        {plan?.text ? <RichText>{plan.text}</RichText> : <p className="text-ink-3">The proposed plan will appear here as the agent writes it.</p>}
      </div>
      <footer className="grid gap-3 border-t border-line p-4">
        <p className="text-xs text-ink-3">Saved with this conversation, outside your project.</p>
        {team ? (
          <p className="text-xs text-ink-2">The team lead coordinates implementation using this conversation’s saved permissions.</p>
        ) : (
          <>
            <label className="grid gap-1 text-xs text-ink-2">
              Implementation mode
              <Select value={permission} onChange={(e) => setPermission(e.target.value as PermissionPreset)}>
                {implementationModes.map((value) => (
                  <option key={value} value={value}>
                    {executionModePresentation(thread.agent, value).label}
                  </option>
                ))}
              </Select>
            </label>
            <p className="text-xs text-ink-3">{executionModePresentation(thread.agent, permission).hint}</p>
          </>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={!ready || !current || busy || implementing}
            onClick={() => plan && (team ? implementTeam.mutate({ threadId: thread.id, planId: plan.id }) : implement.mutate({ id: thread.id, planId: plan.id, permissionMode: permission }))}
          >
            {implementing ? "Starting…" : "Implement this plan"}
          </Button>
          <TextButton disabled={!ready} onClick={() => setExporting(!exporting)}>
            Export to project…
          </TextButton>
        </div>
        {plan && !current ? <p className="text-xs text-ink-3">Select the latest revision to implement.</p> : null}
        {exporting && plan ? (
          <div className="grid gap-2">
            <Input aria-label="Plan export filename" value={filename} onChange={(e) => setFilename(e.target.value)} />
            <Button
              size="sm"
              disabled={!ready || exportPlan.isPending || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/.test(filename)}
              onClick={() => exportPlan.mutate({ id: thread.id, planId: plan.id, filename })}
            >
              Create Markdown file
            </Button>
          </div>
        ) : null}
        {error ? (
          <p className="text-xs text-bad" role="alert">
            {error.message}
          </p>
        ) : null}
        {exportPlan.data ? (
          <p className="break-all text-xs text-ink-3" role="status">
            Exported to {exportPlan.data.path}
          </p>
        ) : null}
      </footer>
    </section>
  );
}
