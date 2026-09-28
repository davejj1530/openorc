/** Disposable, deterministic content for the native desktop workflow smoke. */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db, projects, tasks, threads, runs, LedgerWriter, memories, settings } from "../packages/db/src/index";
import { git } from "../packages/git/src/index";

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "openorc-workflow-qa-"));
  const repo = join(dir, "repository");
  const data = join(dir, "data");
  await mkdir(repo);
  await mkdir(data);
  await git(repo, ["init", "-q", "-b", "main"]);
  await git(repo, ["config", "user.name", "OpenOrc QA"]);
  await git(repo, ["config", "user.email", "qa@openorc.local"]);
  await writeFile(join(repo, "README.md"), "# Workflow fixture\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-qm", "QA fixture"]);
  const db = Db.open(join(data, "openorc.sqlite"));
  settings.set(db, "extraction.provider", "off");
  const project = projects.insert(db, { name: "OpenOrc", rootPath: repo, gitRemote: null, defaultBranch: "main", settings: {} });
  const thread = threads.insert(db, { projectId: project.id, title: "Make the daily workflow feel effortless", agent: "codex", model: null, mode: "plan", permissionMode: "trusted" });
  threads.update(db, thread.id, { pinnedAt: Date.now() });
  for (const title of [
    "Review the memory retrieval pipeline",
    "A very long conversation title about durable sessions, provider handoffs, and recovering unfinished work without losing context",
    "Prepare the first private beta",
  ])
    threads.insert(db, { projectId: project.id, title, agent: "claude", model: null, mode: "plan", permissionMode: "trusted" });
  const titles = [
    "Keep drafts safe when switching conversations",
    "Make task creation a focused writing experience",
    "Review changes before an agent starts its next turn",
    "Support extremely long task titles and repository branch names without pushing properties or primary controls outside their columns",
  ];
  const statuses = ["review", "backlog", "in_progress", "backlog"] as const;
  let taskId = "";
  let progressTaskId = "";
  titles.forEach((title, i) => {
    const task = tasks.insert(db, {
      projectId: project.id,
      threadId: thread.id,
      title,
      spec: "## Outcome\nThe developer can pick up exactly where they left off.\n\n## Acceptance criteria\n- [ ] Keep the draft when navigating away\n- [ ] Retain attachments after a failed send\n- [ ] Show a useful recovery action\n\nRun `pnpm test` before handing off.",
      priority: i === 0 ? "high" : "medium",
      labels: ["experience"],
      workspaceMode: "worktree",
      baseRef: "main",
      parentTaskId: null,
    });
    tasks.update(db, task.id, { status: statuses[i] });
    if (i === 0) taskId = task.id;
    if (i === 2) progressTaskId = task.id;
  });
  const run = runs.insert(db, { id: "qa-run", taskId: null, threadId: thread.id, agent: "codex", model: null, mode: "plan", permissionMode: "trusted" });
  runs.update(db, run.id, { state: "success", endedAt: Date.now(), resultText: "The workflow is ready for review." });
  const ledger = new LedgerWriter(db);
  ledger.push({
    type: "message.completed",
    runId: run.id,
    ts: Date.now() - 10000,
    messageId: "qa-user",
    role: "user",
    text: "Help me make the daily workflow feel effortless. Start with task creation and keeping drafts safe.",
  });
  ledger.push({
    type: "message.completed",
    runId: run.id,
    ts: Date.now(),
    messageId: "qa-assistant",
    role: "assistant",
    text: "I traced the path from an idea to a reviewed change.\n\n### A place to shape the work\nTasks should open as documents: a clear title, a description with enough room to think, and properties that stay out of the way. Saving an idea to backlog should never start an agent.\n\n### Pick up where you left off\nYour draft stays with the conversation. A failed send keeps the message and attachments ready to retry.\n\nThe next step is to test this at a narrow window size, with long titles and realistic task descriptions.",
  });
  const child = runs.insert(db, { id: "qa-progress-run", taskId: progressTaskId, threadId: null, agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  // Stored as ended for startup recovery; the smoke restores the simulated active state after boot.
  runs.update(db, child.id, { state: "success", endedAt: Date.now() });
  ledger.push({ type: "tool.started", runId: run.id, ts: Date.now(), toolCallId: "qa-delegate", name: "openorc.task_start", input: { id: progressTaskId } });
  ledger.push({
    type: "tool.completed",
    runId: run.id,
    ts: Date.now(),
    toolCallId: "qa-delegate",
    name: "openorc.task_start",
    output: { content: [{ type: "text", text: JSON.stringify({ id: progressTaskId, status: "in_progress" }) }] },
    isError: false,
  });
  ledger.push({ type: "session.started", runId: child.id, ts: Date.now(), agent: "codex", externalSessionId: "qa-session", model: null });
  ledger.push({
    type: "message.delta",
    runId: child.id,
    ts: Date.now(),
    messageId: "qa-progress",
    role: "assistant",
    text: "I found the settings layout and am checking the provider adapters. The task’s commentary should be readable here while the agent works.",
  });
  ledger.push({ type: "tool.started", runId: child.id, ts: Date.now(), toolCallId: "qa-context", name: "openorc.task_context", input: {} });
  ledger.push({
    type: "approval.requested",
    runId: child.id,
    ts: Date.now(),
    approvalId: "qa-consent",
    kind: "tool",
    toolName: "openorc.task_context",
    input: { mode: "form", requestedSchema: { type: "object", properties: {} } },
  });
  ledger.close();
  memories.upsert(db, {
    projectId: project.id,
    type: "lesson",
    title: "Keep the draft until delivery succeeds",
    body: "Clear a draft and its attachments only after the agent accepts the message. Navigation must preserve work immediately.",
    source: "user",
  });
  db.close();
  await writeFile(join(dir, "fixture.json"), JSON.stringify({ dir, data, repo, projectId: project.id, taskId, progressTaskId, threadId: thread.id }));
  console.log(join(dir, "fixture.json"));
}
void main();
