import { relativeTime } from "@openorc/client";
import type { OnlineTask, OnlineTaskRef } from "@openorc/protocol";
import { useShownTaskActivity } from "../../lib/task-activity-shown";
import { activityWords, useTaskHistory } from "../../lib/task-history";
import { AccountFace } from "../AccountFace";
import { Button } from "../ui";
import { TeamReports } from "./TaskReports";

export function TaskOnlineHistory({ reference, task }: { reference: OnlineTaskRef; task: OnlineTask }) {
  const history = useTaskHistory(reference);
  const activity = useShownTaskActivity(task.activity);
  return (
    <section className="task-activity">
      <h2 className="text-base mb-4">Activity</h2>
      {activity ? (
        <div className="mb-5 text-sm text-ink-2">
          <p>{activity.state === "waiting" ? (activity.waitingFor ?? "Waiting") : activity.state}</p>
          <p className="mt-1 text-ink-3 break-words">{activity.latestMessage ?? activity.lastAction}</p>
        </div>
      ) : null}
      <TeamReports reference={reference} task={task} />
      {history.error ? (
        <p role="alert" className="text-sm text-bad">
          Activity couldn’t load.{" "}
          <Button size="sm" onClick={() => void history.refetch()}>
            Try again
          </Button>
        </p>
      ) : null}
      {history.isLoading ? <p className="text-sm text-ink-3">Loading activity…</p> : null}
      {history.entries.map((entry) => (
        <div key={entry.id} className="flex items-start gap-2 mt-4 text-sm text-ink-3">
          {entry.actor ? <AccountFace name={entry.actor.name} image={entry.actor.image} className="task-assignee-face" /> : null}
          <div className="min-w-0">
            <p>
              {entry.actor?.name ? `${entry.actor.name} · ` : ""}
              {activityWords(entry)}
            </p>
            <p className="text-xs mt-0.5">{relativeTime(entry.at)}</p>
          </div>
        </div>
      ))}
      {!history.error && history.hasNextPage ? (
        <Button className="mt-4" disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>
          Show earlier activity
        </Button>
      ) : null}
    </section>
  );
}
