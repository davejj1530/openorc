import { relativeTime } from "@openorc/client";
import { harnessShortName, isHarnessId, type OnlineTask, type OnlineTaskRef, type OnlineTaskReport } from "@openorc/protocol";
import { useTaskProjects } from "../../lib/task-list-source";
import { useTaskOnlineMutation, useTaskOnlineQuery, useTaskOnlineScope } from "../../lib/task-online-query";
import { HarnessLogo } from "../HarnessLogo";
import { UpdatePiece } from "../TaskUpdate";

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/** Whose agent wrote an update and where it ran: "Claude for Dana, on OpenOrc Cloud", or "on your computer". */
function authorWords(report: OnlineTaskReport, me: string | null): string {
  const agent = isHarnessId(report.author.agent) ? harnessShortName(report.author.agent) : "An agent";
  const mine = report.author.userId === me;
  if (report.author.place === "cloud") return `${agent} for ${mine ? "you" : firstName(report.author.name)}, on OpenOrc Cloud`;
  return `${agent}, on ${mine ? "your" : `${firstName(report.author.name)}'s`} computer`;
}

/** One agent's update on a team task: whose agent it was and where, its words, and its card and replies, which the task's assignee answers. */
function TeamReport({ reference, task, report, projectId }: { reference: OnlineTaskRef; task: OnlineTask; report: OnlineTaskReport; projectId: string | null }) {
  const answer = useTaskOnlineMutation(reference, "tasks.online.answerReport");
  const me = useTaskOnlineScope().availability?.accountId ?? null;
  const mayAnswer = !task.assignee || task.assignee.userId === me;
  const given = report.answer ? { reply: report.answer.reply, at: report.answer.at, by: report.answer.userId === me ? null : firstName(report.answer.name) } : null;
  return (
    <div className="mt-4 text-sm">
      <p className="flex items-center gap-1.5 text-ink-3">
        {isHarnessId(report.author.agent) ? <HarnessLogo id={report.author.agent} size={14} /> : null}
        <span className="truncate">{authorWords(report, me)}</span>
        <span className="shrink-0">· {relativeTime(report.at)}</span>
      </p>
      <p className="mt-1 text-ink break-words">{report.message}</p>
      <div className="mt-2">
        <UpdatePiece
          projectId={projectId}
          card={report.card}
          replies={report.replies}
          answering={{
            send: (reply) => answer.mutate({ spaceId: reference.spaceId, id: reference.id, reportId: report.id, reply }),
            pending: answer.isPending,
            error: answer.error?.message ?? null,
            given,
            mayAnswer,
          }}
        />
      </div>
    </div>
  );
}

/**
 * Agents' updates on a team task, newest first, which everyone who reads the task sees. A pull request on one is drawn
 * from GitHub where the project has a folder on this computer.
 */
export function TeamReports({ reference, task }: { reference: OnlineTaskRef; task: OnlineTask }) {
  const { availability } = useTaskOnlineScope();
  const served = availability?.reports === true;
  const reports = useTaskOnlineQuery(reference, "tasks.online.reports", { spaceId: reference.spaceId, id: reference.id }, served);
  const paired = useTaskProjects(served ? reference : null);
  const projectId = paired.data?.find((project) => project.hostedProjectId === task.projectId)?.localProjectId ?? null;
  const shown = [...(reports.data ?? [])].reverse();
  if (shown.length === 0) return null;
  return (
    <div className="mb-5" aria-label="Updates">
      {shown.map((report) => (
        <TeamReport key={report.id} reference={reference} task={task} report={report} projectId={projectId} />
      ))}
    </div>
  );
}
