import { lazy, Suspense } from "react";
import { relativeTime, type TaskLineUpdate } from "@openorc/client";
import type { TaskUpdateCard } from "@openorc/protocol";
import { useRpc, useRpcMutation } from "../lib/client";
import { pullRequestTone, pullRequestToneLabel, reviewDecisionLabel } from "../lib/pull-requests";
import { openPullRequest } from "../lib/router";
import { PullStateGlyph } from "./PullStateGlyph";
import { StatusIcon } from "./status";
import { Button } from "./ui";

const VisualizationResult = lazy(() => import("./VisualizationResult"));

type Checklist = Extract<TaskUpdateCard, { kind: "checklist" }>;

/** A plan or a set of notes: its name, how many of its items are done, and each item with its state. */
function ChecklistCard({ card }: { card: Checklist }) {
  const done = card.items.filter((item) => item.done).length;
  return (
    <>
      <div className="task-update-head">
        <span className="truncate">{card.title}</span>
        <span className="task-update-count">
          {done} of {card.items.length}
        </span>
      </div>
      <ul>
        {card.items.map((item, index) => (
          <li key={index} className="task-update-item" data-done={item.done || undefined}>
            <StatusIcon status={item.done ? "done" : "backlog"} />
            <span className="task-update-item-text">{item.text}</span>
            {item.detail ? <span className="task-update-item-detail">{item.detail}</span> : null}
            <span className="sr-only">{item.done ? "Done" : "Not done"}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** A pull request as GitHub has it now, whatever it was when the agent posted: its state, name and size, and the way to it. */
function PullRequestCard({ projectId, number }: { projectId: string; number: number }) {
  const pull = useRpc("pulls.get", { projectId, number });
  if (!pull.data)
    return (
      <div className="task-update-head text-ink-3">
        <span className="tabular">#{number}</span>
        {pull.isError ? <span role="alert">This pull request couldn’t be read.</span> : null}
      </div>
    );
  const tone = pullRequestTone(pull.data);
  const review = pull.data.state === "open" && pull.data.reviewDecision ? reviewDecisionLabel[pull.data.reviewDecision].label : null;
  return (
    <button type="button" className="task-update-pull" onClick={() => openPullRequest(projectId, number)}>
      <span className="task-update-head">
        <PullStateGlyph state={tone} />
        <span className="truncate">
          <span className="tabular text-ink-3">#{number}</span> {pull.data.title}
        </span>
        <span className="task-update-count font-mono">
          <span className="text-ok">+{pull.data.additions}</span> <span className="text-bad">-{pull.data.deletions}</span>
        </span>
      </span>
      <span className="task-update-pull-facts">{[pullRequestToneLabel[tone], review, `${pull.data.headRefName} → ${pull.data.baseRefName}`].filter(Boolean).join(" · ")}</span>
    </button>
  );
}

/**
 * What an agent's update carries under its words, on a piece of its own: its card, and the replies it offers. A reply
 * pressed reaches the agent's thread as the person's message, and the piece keeps which one it was.
 */
export function TaskUpdate({ taskId, projectId, eventId, update }: { taskId: string; projectId: string; eventId: number; update: TaskLineUpdate }) {
  const answer = useRpcMutation("tasks.answerUpdate");
  const { card, replies, answer: given } = update;
  if (!card && replies.length === 0) return null;
  return (
    <div className="task-update" data-plane>
      {card?.kind === "checklist" ? <ChecklistCard card={card} /> : null}
      {card?.kind === "pull_request" ? <PullRequestCard projectId={projectId} number={card.number} /> : null}
      {card?.kind === "visual" ? (
        <Suspense fallback={<p className="text-sm text-ink-3">{card.title}</p>}>
          <VisualizationResult visualization={card} />
        </Suspense>
      ) : null}
      {replies.length > 0 ? (
        <div className="task-update-foot" data-alone={card ? undefined : ""}>
          {given ? (
            <span>
              You answered <span className="text-ink">{given.reply}</span> · {relativeTime(given.at)}
            </span>
          ) : (
            replies.map((reply, index) => (
              <Button key={reply} size="sm" variant={index === 0 ? "primary" : "secondary"} disabled={answer.isPending} onClick={() => answer.mutate({ taskId, eventId, reply })}>
                {reply}
              </Button>
            ))
          )}
          {answer.error ? (
            <p role="alert" className="task-update-error">
              Couldn’t send: {answer.error.message}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
