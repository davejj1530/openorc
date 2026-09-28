import "./team-window-stub";
/** Production team conversation with deterministic runtime and ledger data; no provider calls. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { Panel } from "../../apps/desktop/src/renderer/src/components/Panel";
import { TeamConversation } from "../../apps/desktop/src/renderer/src/components/TeamConversation";
import { core } from "../../apps/desktop/src/renderer/src/lib/rpc";
import { queryClient } from "../../apps/desktop/src/renderer/src/lib/query";
import { emptyRun, getRun, seedRun } from "../../apps/desktop/src/renderer/src/lib/transcript";
import { useTheme } from "../../apps/desktop/src/renderer/src/lib/theme";

window.addEventListener("error", (event) => console.error(event.error?.stack ?? event.message));

const at = Date.now() - 40_000;
const settings = { agent: "codex", model: "fixture-sol", effort: "high", fastMode: false };
const members = ["Lead", "Sol 1", "Sol 2"].map((name, index) => ({
  key: index === 0 ? "lead" : `sol${index}`,
  name,
  managerKey: index === 0 ? null : "lead",
  responsibility: "Help with the project",
  settings,
}));
const actors = members.map((member, index) => ({
  id: index === 0 ? "lead" : `member:${member.key}`,
  memberKey: member.key,
  taskId: null,
  parentId: index === 0 ? null : "lead",
  title: member.name,
  createdAt: at,
  state: "completed",
  settings,
  runIds: [member.key],
  runs: [
    {
      id: member.key,
      turnId: `${member.key}-turn`,
      turn: 0,
      startedAt: at + index * 1000,
      reason: index === 2 ? "ambient" : "addressed",
      silent: index === 2,
      changedFiles: index === 1 ? ["src/app.ts", "src/theme.css"] : [],
    },
  ],
  activeRunId: null,
  error: null,
  result: null,
  retry: { allowed: false, reason: null },
  workspace: null,
}));
const readers = actors.map((actor, index) => ({ actorId: actor.id, name: members[index].name }));
const message = (id, text) => ({ kind: "message", role: "assistant", id, text, streaming: false });
const blocks = [
  message("commentary", "Checking the implementation and its tests."),
  ...Array.from({ length: 9 }, (_, i) =>
    i % 2
      ? { kind: "thinking", id: `think-${i}`, text: "Check behavior", startedAt: at, endedAt: at + 1000 }
      : { kind: "tool", id: `tool-${i}`, name: "exec", input: { command: `pnpm check-part-${i}` }, done: true, output: "Checks passed" },
  ),
  message("final", "The changes are ready for review. All checks passed."),
];
for (const actor of actors) {
  let entries = blocks;
  if (actor.id === "lead") entries = [message("lead-reply", "I’ll coordinate the changes. @Sol 1, please check the implementation.")];
  else if (actor.memberKey !== "sol1")
    entries = [{ kind: "tool", id: "ambient-read", name: "read_file", input: { path: "README.md" }, done: true, output: "Project overview" }, message("silent", "Nothing to add.")];
  seedRun({
    ...emptyRun(actor.memberKey),
    blocks: entries,
    blockIndex: new Map(entries.map((b, i) => [b.id, i])),
    turnOf: new Map(entries.map((b) => [b.id, 0])),
    hydrated: true,
    eventCount: entries.length,
    turnsCompleted: 1,
  });
}
const initial = {
  instance: { id: "instance", threadId: "thread", teamRevisionId: "revision", leadOverrides: {} },
  revision: { id: "revision", teamId: "team", name: "Team Alpha", number: 1, members },
  executions: [
    {
      id: "execution",
      state: "completed",
      activity: "idle",
      generation: 1,
      createdAt: at,
      updatedAt: at + 10_000,
      error: null,
      initialPrompt: { text: "Please simplify the team conversation.", attachments: [], createdAt: at, seenBy: readers.slice(0, 2) },
      actors,
      userDirections: [],
      publications: [],
      chat: [
        {
          id: "chat",
          senderId: "member:sol2",
          senderName: "Sol 2",
          text: "@lead Review complete. Use `claude auth status`.\n\n1. Check prerequisites.\n2. Add a project.",
          attachments: [],
          createdAt: at + 4000,
          to: [{ actorId: "lead", name: "Lead", state: "delivered" }],
        },
      ],
    },
  ],
  actions: { fork: { allowed: true, reason: null } },
  context: { compact: { allowed: true, reason: null }, checkpoints: [] },
  policy: { requested: "trusted", effective: "trusted", pendingRestart: false, runs: [], mode: { requested: "act", effective: "act", pending: false } },
};
let data = initial;
const changeFiles = [
  { path: "src/app.ts", added: 1, removed: 1 },
  { path: "src/theme.css", added: 1, removed: 1 },
];
const reviewCalls: unknown[] = [];
const approvalCalls: unknown[] = [];
core.call = (async (method, params) => {
  if (method === "review.threadDiff") return { files: [], patch: "" };
  if (method === "orchestration.turnChanges") {
    reviewCalls.push(params);
    const selected = params.paths ? changeFiles.filter((file) => params.paths.includes(file.path)) : changeFiles;
    return {
      files: selected,
      attribution: "shared-checkpoint",
      note: "Shared workspace checkpoint",
      patch: params.includePatch ? selected.map((file) => `diff --git a/${file.path} b/${file.path}\n--- a/${file.path}\n+++ b/${file.path}\n@@ -1 +1 @@\n-old value\n+saved value\n`).join("") : null,
    };
  }
  if (method === "approvals.resolve") {
    approvalCalls.push(params);
    const run = getRun(params.runId)!;
    seedRun({
      ...run,
      blocks: run.blocks.map((block) => (block.kind === "approval" && block.approvalId === params.approvalId ? { ...block, decision: params.decision, answers: params.answers } : block)),
    });
    return {};
  }
  if (method === "events.page" && params.runId === "assignment")
    return {
      events: [{ type: "approval.requested", ts: at + 5000, approvalId: "nested-question", kind: "user_input", input: { questions: [{ id: "scope", question: "Which files should I review?" }] } }],
      fromTurn: 0,
      live: false,
    };
  if (method === "orchestration.runtime") return data;
  if (method === "orchestration.availability") return { enabled: true };
  if (method === "threads.permissions") return data.policy;
  if (method === "agents.models") return [{ id: "fixture-sol", label: "Sol", agent: "codex", efforts: ["high"], defaultEffort: "high" }];
  return [];
}) as typeof core.call;
function App() {
  const [runtime, setRuntime] = useState(initial);
  Object.assign(window, {
    teamSmoke: {
      reviewCalls,
      approvalCalls,
      streamReply: (text, complete = false) => {
        seedRun({ ...getRun("sol1")!, blocks: [...blocks.slice(0, -1), { ...message("final", text), streaming: !complete }], live: !complete });
        data = {
          ...data,
          executions: [
            {
              ...data.executions[0],
              state: complete ? "completed" : "active",
              activity: complete ? "idle" : "working",
              actors: data.executions[0].actors.map((actor) => (actor.memberKey === "sol1" ? { ...actor, state: complete ? "completed" : "running", activeRunId: complete ? null : "sol1" } : actor)),
            },
          ],
        };
        setRuntime(data);
      },
      nestedQuestion: () => {
        data = {
          ...data,
          executions: [
            {
              ...data.executions[0],
              actors: [
                ...data.executions[0].actors,
                {
                  ...actors[1],
                  id: "assignment",
                  taskId: "assignment",
                  title: "Review the files",
                  runIds: ["assignment"],
                  runs: [{ id: "assignment", turnId: "assignment-turn", turn: 0, startedAt: at + 5000 }],
                  activeRunId: "assignment",
                  state: "running",
                },
              ],
            },
          ],
        };
        setRuntime(data);
      },
      finish: () => {
        const run = getRun("sol1")!;
        seedRun({ ...run, blocks: [...run.blocks, { kind: "status", id: "done", boundary: "turn", outcome: "success", tone: "ok", text: "turn finished", at: at + 15000 }] });
        // A settled transcript also has a settled runtime turn. Its end time
        // moves the turn below earlier chat and assignment entries in the feed.
        data = {
          ...data,
          executions: [
            {
              ...data.executions[0],
              state: "completed",
              activity: "idle",
              updatedAt: at + 15000,
              actors: data.executions[0].actors.map((actor) => ({
                ...actor,
                state: "completed",
                activeRunId: null,
                runs: actor.memberKey === "sol1" ? actor.runs.map((turn) => ({ ...turn, endedAt: at + 15000 })) : actor.runs,
              })),
            },
          ],
        };
        setRuntime(data);
      },
      theme: (choice) => useTheme.getState().set(choice),
      everyone: () => {
        data = { ...data, executions: [{ ...data.executions[0], initialPrompt: { ...data.executions[0].initialPrompt, seenBy: readers } }] };
        setRuntime(data);
      },
      working: () => {
        data = {
          ...data,
          executions: [
            {
              ...data.executions[0],
              state: "active",
              activity: "working",
              actors: data.executions[0].actors.map((actor) =>
                actor.memberKey === "sol1" ? { ...actor, state: "running", activeRunId: "sol1" } : { ...actor, state: "waiting", waitReason: "Ready for a message" },
              ),
            },
          ],
        };
        setRuntime(data);
      },
      approval: () => {
        const run = getRun("sol1")!;
        seedRun({ ...run, pendingApprovals: 1, blocks: [...run.blocks, { kind: "approval", id: "approval", approvalId: "approval", approvalKind: "command", input: { command: "pnpm verify" } }] });
      },
    },
  });
  const thread = { id: "thread", mode: "act", permissionMode: "trusted", workspaceMode: "current", ...settings } as never;
  const project = { id: "project", rootPath: "/tmp", name: "OpenOrc" } as never;
  return (
    <div className="flex h-full min-w-0">
      <div className="flex-1 min-w-0">
        <TeamConversation data={runtime as never} thread={thread} project={project} refresh={() => {}} refreshError={null} />
      </div>
      <Panel context={{ kind: "thread", thread, project }} />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
);
