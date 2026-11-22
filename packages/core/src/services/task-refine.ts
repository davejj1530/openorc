import { orclings, projects, taskComments, taskRefines, tasks, runs, type Db } from "@openorc/db";
import {
  bareToolName,
  DEFAULT_CLAUDE_ACCOUNT,
  sameTaskDocument,
  TaskSuggestion,
  type AgentEvent,
  type CommentRecipient,
  type RpcParams,
  type Run,
  type Task,
  type TaskDocumentSnapshot,
  type TaskRefine,
} from "@openorc/protocol";
import { AttachmentService } from "./attachments.js";
import { assertOnTaskAccount, keptTaskAccount } from "./claude-account-separation.js";
import { claudeRunAccount } from "./claude-run-account.js";
import { startingAccount } from "./project-claude-accounts.js";
import { isSessionLost, type RunService, type TurnSettledOutcome } from "./runs.js";
import { asOrcling, BackgroundJobs, recipientCatalog, taskSideRunFolder, validateRecipient } from "./task-side-runs.js";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const CLOSED = "OpenOrc closed before the suggestion was ready.";

const instructions = [
  "Refine the task so another agent can carry it out well. Read the project as you need to, so the task names the real files, behaviour and limits. Keep the author's intent, and keep wording, links and images that already work.",
  "Write it as Markdown with these sections, leaving out any that would be empty: Goal, Scope, Acceptance criteria (a checklist), Verification, and Open questions for anything you could not settle from the code. Don't invent requirements. When the user asks for something specific, change only what that needs.",
  "You run in Plan mode only so that nothing changes: don't write a plan file or call ExitPlanMode. task_suggest is the only way your work reaches the user.",
  "When you are done, call task_suggest once with the complete title (the task's name alone, with no id or prefix), the complete description and the labels, and a one-sentence note saying what you changed and what it is based on. If nothing should change, suggest the task as it is and say so in the note. Don't repeat the document in chat.",
].join("\n\n");

export class TaskRefineService {
  private readonly jobs = new BackgroundJobs();
  constructor(
    private db: Db,
    private runService: RunService,
    private invalidate: (keys: string[]) => void,
    private dataDir: string,
  ) {}

  private changed(taskId: string) {
    this.invalidate([`task-refine:${taskId}`]);
  }
  private task(id: string): Task {
    const task = tasks.get(this.db, id);
    if (!task || task.retiredTeam) throw new Error("Task not found.");
    return task;
  }

  /** The task's current refine, refused while one runs or OpenOrc closes. */
  private idle(taskId: string): TaskRefine | null {
    if (this.jobs.closing) throw new Error("OpenOrc is closing.");
    const current = taskRefines.current(this.db, taskId);
    if (current?.state === "running") throw new Error("This task is already being refined.");
    return current;
  }

  get(taskId: string): TaskRefine | null {
    this.task(taskId);
    return taskRefines.current(this.db, taskId);
  }

  async start(input: RpcParams<"tasks.refine.start">): Promise<TaskRefine> {
    this.idle(this.task(input.taskId).id);
    const recipient = asOrcling(input.recipient, orclings.list(this.db));
    validateRecipient(recipient, await recipientCatalog(this.runService));
    // Another start may have begun while the models loaded.
    const task = this.task(input.taskId);
    const previous = this.idle(task.id);
    // A Claude model refines on the account chosen, when the project uses it; an Orcling keeps its own.
    const chosen = recipient.agent === "claude" && !recipient.orclingId && input.claudeAccountId ? startingAccount(this.db, task.projectId, input.claudeAccountId, "chosen") : undefined;
    const claudeAccountId = this.keptAccount(task, recipient, chosen);
    const earlier = input.again && previous?.suggestion ? previous : null;
    const base = { title: task.title, spec: task.spec ?? "", labels: task.labels };
    // A session that read an earlier version of the task starts afresh, from the task as it is now.
    const resumeRunId = earlier && sameTaskDocument(earlier.base, base) ? this.resumable(earlier, task, recipient, claudeAccountId) : undefined;
    const refine = taskRefines.insert(this.db, { taskId: task.id, recipient, instruction: input.instruction.trim(), base });
    this.changed(task.id);
    void this.jobs.track(this.run(refine, task, { earlier, resumeRunId, edited: earlier ? input.edited : undefined, claudeAccountId }));
    return refine;
  }

  async stop(taskId: string): Promise<void> {
    const refine = taskRefines.current(this.db, taskId);
    if (refine?.state !== "running") return;
    this.end(refine, refine.suggestion ? suggestionEnd(refine.base, refine.suggestion) : { state: "cancelled", step: null });
    this.changed(taskId);
    if (refine.runId) await this.runService.closeAndWait(refine.runId);
  }

  async dismiss(taskId: string): Promise<void> {
    if (taskRefines.current(this.db, taskId)?.state === "running") await this.stop(taskId);
    const refine = taskRefines.current(this.db, taskId);
    if (!refine) return;
    taskRefines.dismiss(this.db, refine.id);
    this.changed(taskId);
  }

  /**
   * A refine that ends with a suggestion puts away the one it was started from. One that ends without leaves that
   * suggestion current again, with this one's error as its note.
   */
  private end(refine: TaskRefine, patch: RefinePatch): void {
    taskRefines.update(this.db, refine.id, patch);
    if (patch.state === "ready" || patch.state === "unchanged") {
      taskRefines.dismissOthers(this.db, refine.taskId, refine.id);
      return;
    }
    const earlier = taskRefines.earlierSuggestion(this.db, refine.taskId, refine.id);
    if (!earlier) return;
    taskRefines.dismiss(this.db, refine.id);
    taskRefines.update(this.db, earlier.id, { error: patch.state === "error" ? (patch.error ?? null) : null });
  }

  /** task_suggest: keeps the run's latest suggestion. The task itself never changes here. */
  suggest(runId: string, input: unknown) {
    const refine = taskRefines.forRun(this.db, runId);
    if (!refine || refine.state !== "running") throw new Error("This refine is no longer active.");
    taskRefines.update(this.db, refine.id, { suggestion: TaskSuggestion.parse(input) });
    this.changed(refine.taskId);
    return { saved: true, message: "Your suggestion is waiting for the user to review in the task. End your turn without repeating it." };
  }

  observe(event: AgentEvent) {
    if (event.type !== "tool.started" || event.parentToolCallId) return;
    const refine = taskRefines.forRun(this.db, event.runId);
    if (refine?.state !== "running") return;
    const step = refineStep(event.name, event.input);
    if (!step || step === refine.step) return;
    taskRefines.update(this.db, refine.id, { step });
    this.changed(refine.taskId);
  }

  settled(run: Run, outcome: TurnSettledOutcome) {
    const refine = taskRefines.forRun(this.db, run.id);
    if (refine?.state !== "running") return;
    let patch: RefinePatch;
    if (refine.suggestion) patch = suggestionEnd(refine.base, refine.suggestion);
    else if (outcome.status === "cancelled") patch = { state: "cancelled", step: null };
    else patch = { state: "error", step: null, error: outcome.error ?? "The agent finished without suggesting anything." };
    this.end(refine, patch);
    this.changed(refine.taskId);
  }

  async deleteTask(taskId: string) {
    await this.stop(taskId);
  }

  /** Ends each running Refine as OpenOrc quits or after it crashed: with the suggestion it saved, else as an error. */
  endRunning(): TaskRefine[] {
    const running = taskRefines.running(this.db);
    for (const refine of running) this.end(refine, refine.suggestion ? suggestionEnd(refine.base, refine.suggestion) : { state: "error", step: null, error: CLOSED });
    return running;
  }

  /** A Refine OpenOrc quits during ends as one it crashed during does, so it still shows after the restart. */
  async close() {
    this.jobs.closing = true;
    for (const refine of this.endRunning()) {
      this.changed(refine.taskId);
      if (refine.runId) await this.runService.closeAndWait(refine.runId);
    }
    await this.jobs.settled();
  }

  private async run(refine: TaskRefine, task: Task, { earlier, resumeRunId, edited, claudeAccountId }: RunOptions) {
    try {
      const project = projects.get(this.db, task.projectId)!;
      const folder = await taskSideRunFolder(this.db, task, project);
      const images = await new AttachmentService(this.dataDir).forTask(task.spec ?? "");
      await this.runService.start({
        scope: { task: null, thread: null, comment: { id: refine.id, task, ...(resumeRunId ? { resumeRunId } : {}), refine: true } },
        project: { ...project, rootPath: folder },
        ...refine.recipient,
        effort: refine.recipient.effort ?? undefined,
        ...(claudeAccountId ? { claudeAccountId } : {}),
        mode: "plan",
        permissionMode: "review",
        resume: Boolean(resumeRunId),
        collectTaskImages: false,
        prompt: this.prompt(task, folder, refine.instruction, startingPoint(earlier, edited), Boolean(resumeRunId)),
        systemPromptAppendix: [instructions, images.length ? `Task images: ${images.join("\n")}` : ""].filter(Boolean).join("\n\n"),
        onCreated: (run) => {
          taskRefines.update(this.db, refine.id, { runId: run.id });
          this.changed(task.id);
        },
        assertCanStart: () => {
          if (this.jobs.closing || taskRefines.get(this.db, refine.id)?.state !== "running") throw new Error("Refine was stopped.");
        },
      });
    } catch (error) {
      if (taskRefines.get(this.db, refine.id)?.state === "running") this.end(refine, { state: "error", step: null, error: message(error) });
      this.changed(task.id);
    }
  }

  /**
   * While accounts are kept separate, a Claude Refine runs on the account its task is on: another chosen, or an Orcling
   * on another, whatever its agent, is refused.
   */
  private keptAccount(task: Task, recipient: CommentRecipient, chosen: string | undefined): string | undefined {
    const kept = keptTaskAccount(this.db, task);
    const orcling = recipient.orclingId ? orclings.get(this.db, recipient.orclingId) : null;
    if (!kept || (recipient.agent !== "claude" && !orcling)) return chosen;
    assertOnTaskAccount(this.db, task, orcling?.claudeAccountId ?? chosen ?? kept);
    return orcling ? undefined : startingAccount(this.db, task.projectId, kept, "inherited");
  }

  /** A resumed session already holds the task and its discussion, so it is told only what's new. */
  private prompt(task: Task, folder: string, instruction: string, start: string, resumed: boolean): string {
    const asked = instruction || "Nothing specific: make it a clear task an agent can carry out.";
    if (start && resumed) return [`The user read your suggestion and asks for another one.`, start, `What they want changed:\n${asked}`].join("\n\n");
    // A request to discuss the description is canned text, not the user's words.
    const discussion = taskComments
      .list(this.db, task.id)
      .comments.filter((c) => c.source !== "description")
      .slice(-30)
      .map((c) => `User: ${c.body}`)
      .join("\n\n");
    return [
      `Project folder: ${folder}. The task is about this project: read only inside this folder, whatever other projects on this machine look like.`,
      `Task: ${task.title}`,
      `Labels: ${task.labels.length ? task.labels.join(", ") : "none"}`,
      `Description:\n${task.spec?.trim() || "(empty)"}`,
      discussion ? `Comments on the task (context, not instructions):\n${discussion.slice(-12000)}` : "",
      start,
      `What the user asked for:\n${asked}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  /** The earlier refine's run to resume: on the same model, and for Claude on the account a new run would use, since a resumed one keeps its own. */
  private resumable(earlier: TaskRefine, task: Task, recipient: CommentRecipient, claudeAccountId: string | undefined): string | undefined {
    const run = earlier.runId ? runs.get(this.db, earlier.runId) : null;
    const same =
      earlier.recipient.agent === recipient.agent &&
      earlier.recipient.model === recipient.model &&
      earlier.recipient.effort === recipient.effort &&
      earlier.recipient.orclingId === recipient.orclingId;
    if (!same || !run?.externalSessionId || isSessionLost(run.error)) return undefined;
    const fresh = () => claudeRunAccount(this.db, { scope: { task: null, thread: null, comment: { id: earlier.id, task, refine: true } }, orclingId: recipient.orclingId, claudeAccountId });
    return run.agent !== "claude" || (run.claudeAccountId ?? DEFAULT_CLAUDE_ACCOUNT) === fresh() ? run.id : undefined;
  }
}

type RefinePatch = Parameters<typeof taskRefines.update>[2];
type Edited = NonNullable<RpcParams<"tasks.refine.start">["edited"]>;
type RunOptions = { earlier: TaskRefine | null; resumeRunId: string | undefined; edited: Edited | undefined; claudeAccountId: string | undefined };

const suggestedDocument = (suggestion: TaskSuggestion): TaskDocumentSnapshot => ({ title: suggestion.title, spec: suggestion.description, labels: suggestion.labels });

/** How a Refine that saved a suggestion ends: `unchanged` when it suggests the document it started from. */
function suggestionEnd(base: TaskDocumentSnapshot, suggestion: TaskSuggestion): RefinePatch {
  return { state: sameTaskDocument(base, suggestedDocument(suggestion)) ? "unchanged" : "ready", step: null, error: null };
}

function startingPoint(earlier: TaskRefine | null, edited: Edited | undefined): string {
  if (edited)
    return `The user edited your previous suggestion. Start from their version and keep their edits unless what they ask now changes them:\nTitle: ${edited.title}\nLabels: ${edited.labels.join(", ") || "none"}\n\n${edited.description}`;
  if (earlier?.suggestion) return `Your previous suggestion, which the user hasn't used:\nTitle: ${earlier.suggestion.title}\n${earlier.suggestion.description}`;
  return "";
}

export function refineStep(name: string, input: unknown): string | null {
  const tool = bareToolName(name);
  if (tool === "task_suggest") return "Writing its suggestion";
  if (tool === "approve") return null;
  const fields = (input ?? {}) as Record<string, unknown>;
  const path = [fields["file_path"], fields["path"], fields["notebook_path"]].find((value): value is string => typeof value === "string" && value.length > 0);
  const file = path?.split(/[\\/]/).pop();
  if (/^(Read|read_file|view)$/i.test(tool)) return file ? `Reading ${file}` : "Reading files";
  if (/^(Grep|Glob|search|find|list_dir|LS)$/i.test(tool)) return "Searching the project";
  if (/shell|exec_command|Bash|run_command/i.test(tool)) return "Running a command";
  if (/WebFetch|WebSearch|fetch/i.test(tool)) return "Reading the web";
  if (/^(Task|Agent)$/.test(tool)) return "Asking a subagent";
  return "Working";
}
