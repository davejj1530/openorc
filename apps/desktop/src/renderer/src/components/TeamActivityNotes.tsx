import type { TeamActorView, TeamTaskView } from "@openorc/protocol";
import { TeamTaskStart, TeamTaskAdmissions } from "./TeamTaskStart";
import { Button } from "./ui";

export function TeamActorExplanation({ actor, hasReasoning }: { actor: Pick<TeamActorView, "modeHold" | "runIds" | "state">; hasReasoning: boolean }) {
  if (actor.modeHold === "plan") return <p className="text-sm text-ink-3">Switch to Act to continue this assignment.</p>;
  if (!actor.runIds.length)
    return <p className="text-sm text-ink-3">{actor.state === "queued" ? "Waiting for its manager, dependencies or an available provider slot." : "Activity appears when the agent starts."}</p>;
  if (!hasReasoning) return <p className="team-reasoning-note">No readable reasoning has been provided. Actions and responses appear above.</p>;
  return null;
}

export function SavedTeamTaskHint({ task, taskId, pending, retry }: { task: TeamTaskView | null | undefined; taskId: string | undefined; pending: boolean; retry: () => void }) {
  return (
    <section className="grid gap-3 border-b border-line pb-3" aria-label="Saved task">
      {task ? (
        <>
          <TeamTaskStart key={taskId} task={task} inline />
          <TeamTaskAdmissions task={task} />
        </>
      ) : (
        <p className="team-composer-hint">
          {pending ? "Loading the saved task…" : "Could not load the saved task."}
          {!pending ? (
            <>
              {" "}
              <Button size="sm" variant="ghost" onClick={retry}>
                Retry
              </Button>
            </>
          ) : null}
        </p>
      )}
    </section>
  );
}
