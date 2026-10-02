import { orclings, tasks, threads, type Db } from "@openorc/db";
import { WORKSPACE_ID, type Project, type RunMode, type Task, type Thread } from "@openorc/protocol";
import type { RunHooks } from "./run-types.js";

/** Prompts for a task or conversation, with memory and mode copy in document order. */
export class RunBriefs {
  constructor(
    private readonly db: Db,
    private readonly hooks: Pick<RunHooks, "brief" | "memoryEnabled" | "threadContext">,
  ) {}

  taskBrief(task: Task, project: Project, mode: RunMode, teamManaged = false): string {
    const location =
      task.workspaceMode === "current"
        ? `in the project's default checkout at ${project.rootPath}. Use this checkout; do not create or attach a worktree`
        : `in an isolated worktree on branch ${task.branch ?? "(pending)"}`;
    const lines = [`You are executing task "${task.title}" (id ${task.id}) in project ${project.name}, ${location}.`];
    if (task.spec) lines.push("", "Task spec:", task.spec);
    if (task.threadId) {
      const thread = threads.get(this.db, task.threadId);
      if (thread)
        lines.push(
          "",
          teamManaged
            ? `This assignment belongs to the team conversation "${thread.title}". The team coordinator routes your result to your requesting manager.`
            : `This task was delegated from the thread "${thread.title}". When you finish, your final message is reported back there, so end with a short summary of what changed and what is left.`,
        );
    }
    lines.push(
      "",
      teamManaged
        ? "Stay inside this assignment. Follow the team roster and coordination rules below for delegation and reporting. task_list and task_get provide context for this team's work."
        : "Stay inside this task. Do not create tasks; task_list and task_get show sibling tasks if you need context.",
    );
    if (mode === "plan") lines.push("", "Plan mode: investigate and produce a concrete plan. Do not modify files or run commands that change state.");
    lines.push(
      "",
      this.hooks.memoryEnabled?.() === false
        ? "OpenOrc memory is off. Do not call memory_search, memory_record, or memory_feedback. Task instructions remain available through task_context."
        : "The openorc MCP server offers memory_search, task_context, and memory_record for this project's history. Use task_context before changing an unfamiliar area and memory_record after a failed approach.",
    );
    const memoryBrief = this.hooks.brief(project);
    if (memoryBrief) lines.push("", memoryBrief);
    return lines.join("\n");
  }

  threadBrief(thread: Thread, project: Project, mode: RunMode): string {
    if (orclings.forThread(this.db, thread.id)) return this.orclingHomeBrief(project, mode);
    const own = tasks.list(this.db, { threadId: thread.id }).filter((t) => t.status !== "archived");
    const lines = [this.threadLocation(thread, project)];
    const context = this.hooks.threadContext?.(thread);
    if (context) lines.push("", context);
    lines.push(
      "",
      "Tasks are records of work within this conversation. task_create saves a document without launching an agent. When asked to start a task, call task_start and implement it here in the current thread and workspace. Do not forward work to a separate task agent. Use task_update to record progress and completion. Only open a new thread when the user requests a separate conversation.",
    );
    lines.push(
      mode === "act"
        ? "This thread is in Act mode: carry out the action the user intends. Act grants permission to act; it does not turn every request into implementation. Creating a task, editing its description, investigating, planning, and implementing are different actions. Choose from the user's request and conversation context."
        : "This thread is in plan mode: task_create saves to backlog. You must not modify files or run state-changing commands yourself.",
    );
    lines.push(
      "Intent examples: 'Create a task in the backlog for X' means write and save the task with task_create execution=backlog, then confirm it was saved. Do not implement X or ask to start it. 'Build X' or 'Start this task' requests implementation; work directly in this conversation. 'How would we build X?' requests an explanation or plan, even in Act mode. Never cite Act mode as a reason to start work the user only asked to capture. A bare 'create a task' also saves to backlog unless the surrounding request clearly includes implementation.",
    );
    lines.push("Always call task_list before task_create. Never create a task that already exists; use task_update to refine it. Prefer one well-specified task over several vague ones.");
    lines.push(
      "For ideas, capture, or requests to add a task to backlog, call task_create with execution=backlog. Write a concise title and a polished Markdown spec with Goal, Scope, an Acceptance criteria checklist, and Verification where relevant. task_create only saves the document. task_start marks an existing task in progress in Act mode; continue implementing it yourself in this thread. Manage OpenOrc tasks through these MCP tools, not Computer Use, browser automation, shell scripts, or database writes.",
    );

    lines.push(
      "Delegated task commentary and permission waits stream in the thread's task card. When the user asks for progress, call task_get and report its activity: latestMessage, lastAction, waitingFor, and state. A waiting task is paused for input or permission; say that clearly and direct the user to its request. Do not equate in_progress with active implementation or claim there is no update without reading activity.",
    );
    if (own.length > 0) {
      lines.push("", "Tasks in this thread:");
      for (const t of own) lines.push(`- ${t.id} | ${t.title} | ${t.status}${t.branch ? ` | ${t.branch}` : ""}`);
    }
    lines.push(
      "",
      "Other threads of this project are reachable with thread_list, thread_read, and thread_send. Message a thread only when its work depends on yours or you need something it knows; keep the message short and specific.",
    );
    lines.push(
      "",
      this.hooks.memoryEnabled?.() === false
        ? "OpenOrc memory is off. Do not call memory_search, memory_record, or memory_feedback."
        : "The openorc MCP server also offers memory_search, task_context, and memory_record for this project's history.",
    );
    const memoryBrief = this.hooks.brief(project);
    if (memoryBrief) lines.push("", memoryBrief);
    return lines.join("\n");
  }

  /**
   * An Orcling's own conversation is a chat, not a work thread. Its Orcling brief says who it is and
   * how it reaches projects; no project's memory or task rules come with it, since what they hold
   * would read as its own history.
   */
  private orclingHomeBrief(project: Project, mode: RunMode): string {
    const lines = [`You work in ${project.rootPath}, your own folder for notes and files. It is not a project or a repository. Respect the current permissions for every operation.`];
    if (mode === "plan") lines.push("Plan mode: do not modify files or run commands that change state.");
    return lines.join("\n");
  }

  private threadLocation(thread: Thread, project: Project): string {
    if (project.id === WORKSPACE_ID) {
      return `You are in Workspace conversation "${thread.title}", working in ${project.rootPath}. Workspace is your personal conversation home, not a repository. This folder need not be an imported project or a Git repository. Do not import projects automatically. Respect the current permissions for every operation.`;
    }
    if (thread.worktreePath) {
      const head = thread.branch ? `on branch ${thread.branch}` : "at a detached commit, on no branch";
      return `You are in the thread "${thread.title}" for project ${project.name}, working in this thread's own worktree at ${thread.worktreePath} ${head}.`;
    }
    return `You are in the thread "${thread.title}" for project ${project.name}, working directly in the project folder at ${project.rootPath}${project.defaultBranch ? ` on ${project.defaultBranch}` : ""}.`;
  }
}
