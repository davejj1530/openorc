import { orchestration, projects, threads, type Db } from "@openorc/db";
import type { TeamActorRecord, TeamExecutionRecord } from "@openorc/protocol";

/** Keep coordination proportional to the work, rather than a turn for every acknowledgment. */
const COORDINATION_PACE = [
  "Keep coordination short. Send a message only for a decision, actionable correction, blocker, necessary question or completed result. Do not request or send routine read acknowledgments, repeat another member's report, or restate an unchanged plan.",
  "Give each independent piece one owner, a clear outcome and file boundaries. Once assigned, proceed within that scope without waiting for repeated approvals; ask only when blocked or when scope changes. Use parallel work only for independent pieces and share test results rather than rerunning the same broad checks without a reason.",
  "Acknowledge meaningful user corrections briefly, then route them directly to affected conversation members with team_say. Involve a manager only when a decision or assignment boundary needs them; do not relay ordinary chat through every hierarchy level. Isolated assignments still obey team_message ownership rules. Report a delivery delay or blocker instead of claiming the correction was acted on.",
].join("\n");

/**
 * The team rules a turn's provider receives beside its own instructions: a chat member's conversation rules, or the
 * lead's and assignments' hierarchy rules, in Plan or Act. Guidance for the model; the coordinator enforces the rest.
 */
export function teamTurnInstructions(db: Db, record: TeamExecutionRecord, actor: TeamActorRecord, mode: "plan" | "act", taskInstructions = ""): string {
  const instance = orchestration.getInstance(db, record.threadId)!;
  const revision = orchestration.getRevision(db, instance.teamRevisionId)!;
  const reports = revision.members.filter((member) => member.managerKey === actor.memberKey);
  const descendants = revision.members.filter((member) => {
    let parent = member.managerKey;
    if (parent === actor.memberKey) return false;
    while (parent !== null) {
      if (parent === actor.memberKey) return true;
      parent = revision.members.find((candidate) => candidate.key === parent)!.managerKey;
    }
    return false;
  });
  const parent = record.actors.find((candidate) => candidate.id === actor.parentId);
  const colleagues = revision.members.map((member) => `${member.name} (${member.key}${member.managerKey === null ? ", lead" : ""}): ${member.responsibility}`).join("; ");
  const workspace = record.actors.some((item) => item.participant) ? (threads.get(db, record.threadId)?.worktreePath ?? projects.get(db, record.projectId)?.rootPath ?? "the team workspace") : null;
  if (actor.participant)
    return [
      `TEAM CHAT: You are ${actor.input.title} (${actor.memberKey}), a member of the team "${revision.name}", in one conversation shared with the user and your colleagues. Your responsibility: ${actor.input.responsibility}`,
      `Colleagues: ${colleagues}.`,
      COORDINATION_PACE,
      "The messages addressed to you are in your prompt. Answer them by ending your turn with your reply; the user and your colleagues see it. Do not call team_wait or team_complete for chat.",
      "To ask a colleague or the lead for a reply, call team_say with their member keys in `to`. Mentioning a colleague as @Name (their roster display name) in your reply lets them read it without owing a reply; mention @lead or use team_say when the lead must act. Keep member keys and actor IDs in tool arguments only; never write @key or @UUID in visible messages. Unaddressed chat reaches everyone as context on their next turn. Conversation is not work: never create a task to greet, ask or answer. Create a task only when the user asks you for a task or a feature.",
      `The whole team shares one workspace at ${workspace}. Before editing files, claim them with team_claim (workspace-relative paths); a claim a colleague holds is refused, so ask them in the chat instead. Release claims with team_claim and release=true when you are done. Each turn's changed files are visible to the team. Ask the lead to delegate an isolated assignment for large bounded work.`,
      "Your prompt carries the room messages your session missed, numbered; team_history reads further back.",
      "Some turns are ambient: nobody is waiting for your reply and the prompt says so, because a colleague mentioned you or the room moved on. Then only team_say reaches the team; your final text stays private.",
      "Other threads of this project can also message the team; such messages are attributed to a thread id.",
    ].join("\n");
  const chat = record.actors.some((item) => item.participant)
    ? [
        `Your team members are present in this conversation: ${colleagues}. Talk to them with team_say (member keys in \`to\`) or by mentioning @Name using their roster display name. Keep member keys and actor IDs in tool arguments only; never write @key or @UUID in visible messages. Addressed members are woken and reply in the chat, which the user sees directly. A user message whose header lists members has already reached them and they answer it themselves: answer for yourself, never relay or repeat it, and send team_say only for something they do not have, such as an assignment or a constraint; a member you address while it still holds the user's message reads yours without replying. Never create a task just to ask a member something. The team shares one workspace at ${workspace}; claim files with team_claim before editing them there, and delegate an isolated task_create assignment only for bounded file work that must not collide with the chat. In an ambient turn (the prompt says so) nobody is waiting for your reply: only team_say reaches the team and your final text stays private.`,
      ]
    : [];
  return [
    "TEAM EXECUTION: The following coordination rules replace the ordinary task-delegation and end-after-delegating rules above.",
    ...chat,
    COORDINATION_PACE,
    `Your actor is ${actor.id}. Your responsibility: ${actor.input.responsibility}`,
    `Parent assignment: ${parent ? `${parent.id} (${parent.memberKey})` : "none; you lead this execution"}.`,
    `Direct reports: ${reports.map((member) => `${member.key}: ${member.name} — ${member.responsibility}`).join("; ") || "none"}.`,
    `Further descendants: ${descendants.map((member) => `${member.key}: ${member.name} (reports to ${member.managerKey}) — ${member.responsibility}`).join("; ") || "none"}.`,
    mode === "plan"
      ? "This is a Plan turn. task_create can capture backlog work or execution=delegate can save a proposal, but neither starts an assignment. Do not use task_start or task_complete in this turn. Existing execution requests in prior prompts remain retained context for future Act work."
      : "Use task_create with execution=delegate, member_key and a stable request_key for each bounded assignment. Decide from the user's words: delegate only when they ask for a task, an assignment or a feature to be built. Greetings, questions, opinions, status and coordination are answered in the chat, never turned into tasks. Only direct reports are permitted. Repeated titles may be intentional; request keys identify work.",
    "Use execution=backlog to save future work without starting it. A saved task may retain member_key and dependency_task_ids. In Plan mode, execution=delegate saves a proposal; it does not reserve an assignment or require team_wait. A leaf can capture future work for its own manager to allocate.",
    "In Plan mode, discuss the retained assignments and proposed work without implementing or completing execution tasks. You may end a planning reply while assignments remain; the coordinator preserves them until Act resumes. Changing mode does not approve or start new backlog tasks.",
    "Delegate a subtree through its direct manager; that manager chooses its own assignments. Dependencies can reference only assignments you created, never another manager's children.",
    mode === "plan"
      ? "Answer the user with a plan and end your turn normally. An ordinary successful planning reply leaves unfinished execution work waiting for Act. Do not call team_complete to mark a plan as completed implementation. Saving a proposal does not require team_wait."
      : "After delegating call team_wait and end your turn. Waiting returns immediately and releases your provider slot. Results resume this assignment in order.",
    mode === "plan"
      ? "Retained child results may be inspected as context; queued execution assignments will wait for Act."
      : "Call team_complete with a result before ending a finished assignment. Completion requires all direct assignments and their subtrees to be complete and the latest direction addressed, then a successful turn and captured snapshot. Child output is integrated into your workspace before your next turn; inspect it and report your combined result to your parent.",
    "When the user corrects direction, acknowledge the correction promptly. Read team_status, identify the active workers whose work is affected, and relay the concrete change with team_say to those conversation members or team_message to your direct assignments before returning to waiting. Preserve recipient scope: a message to one member is not permission to broadcast. Do not copy prior reply recipients or ask everyone to acknowledge. Report which workers are still running and which deliveries remain queued or unconfirmed; provider acceptance does not prove a worker has read or acted on it.",
    "Use team_status and team_message for coordination. Messages may address your parent or your own direct assignments. Never launch extra provider processes or bypass the assigned roster. Do not poll while waiting.",
    "Other threads of this project can message the lead; such direction is attributed to a thread id. Reply with thread_send to that id only when a reply is useful. thread_send to another team queues for its lead while that team is running.",
    taskInstructions,
  ].join("\n");
}
