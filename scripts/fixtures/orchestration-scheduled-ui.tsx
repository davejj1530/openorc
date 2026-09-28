/** Synthetic renderer data for the two readability views; no core or provider is connected. */
import "./team-window-stub";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { DEFAULT_TEAM_LIMITS } from "../../packages/protocol/src/orchestration";
import { Orchestration } from "../../apps/desktop/src/renderer/src/views/Orchestration";
import { Scheduled } from "../../apps/desktop/src/renderer/src/views/Scheduled";
import { core } from "../../apps/desktop/src/renderer/src/lib/rpc";
import { queryClient } from "../../apps/desktop/src/renderer/src/lib/query";
import { useLayout } from "../../apps/desktop/src/renderer/src/lib/layout";
import { useRouter } from "../../apps/desktop/src/renderer/src/lib/router";
import { useTheme } from "../../apps/desktop/src/renderer/src/lib/theme";

const project = {
  id: "fixture-project",
  name: "Fixture project",
  rootPath: "/tmp/openorc-readability-fixture",
  defaultBranch: "main",
  gitRemote: null,
  settings: { setupScript: null, worktreeInclude: [], branchPrefix: "openorc/", detectedConfigs: [] },
  createdAt: 1,
  updatedAt: 1,
};
const member = { key: "lead", name: "Lead", responsibility: "Coordinate a review", managerKey: null, settings: { agent: "codex", model: "fixture-model", effort: "medium", fastMode: false } };
let team = {
  team: { id: "fixture-team", projectId: project.id, currentRevisionId: "revision-1", archivedAt: null, createdAt: 1, updatedAt: 1 },
  revision: { id: "revision-1", teamId: "fixture-team", projectId: project.id, number: 1, createdAt: 1, name: "Review team", members: [member], limits: DEFAULT_TEAM_LIMITS },
};
let schedule = {
  id: "fixture-schedule",
  projectId: project.id,
  title: "Daily review",
  prompt: "Review the repository",
  agent: "codex",
  model: "fixture-model",
  effort: "medium",
  mode: "plan",
  permissionMode: "trusted",
  workspaceMode: "worktree",
  everyMinutes: 1440,
  version: 1,
  enabled: true,
  lastRunAt: null,
  nextRunAt: Date.now() + 86400000,
  lastThreadId: null,
  createdAt: 1,
  updatedAt: 1,
  executionTarget: { kind: "model", settings: { agent: "codex", model: "fixture-model", effort: "medium", fastMode: false } },
};
const avatars = [{ teamId: "fixture-team", memberKey: "lead", avatar: { kind: "default", index: 0 }, updatedAt: 1 }];
const harnesses = ["codex", "claude", "opencode"].map((id) => ({ id, state: "ready", path: `/tmp/${id}`, version: "1", revision: 1 }));
const calls: { method: string; input: unknown }[] = [];
core.call = async (method, input) => {
  calls.push({ method, input });
  if (method === "projects.list") return [project];
  if (method === "orchestration.list") return [team];
  if (method === "orchestration.get") return team;
  if (method === "orchestration.availability") return { enabled: true, reason: null, maxHierarchyDepth: 3 };
  if (method === "orchestration.avatars.list") return avatars;
  if (method === "orchestration.avatars.set") {
    avatars[0] = { ...avatars[0], avatar: input.avatar, updatedAt: 2 };
    return avatars[0];
  }
  if (method === "orchestration.avatars.reset") return avatars[0];
  if (method === "orchestration.save") {
    const number = team.revision.number + 1;
    team = { team: { ...team.team, currentRevisionId: `revision-${number}`, updatedAt: number }, revision: { ...team.revision, ...input.draft, id: `revision-${number}`, number, createdAt: number } };
    return team;
  }
  if (method === "orchestration.archive") {
    team = { ...team, team: { ...team.team, archivedAt: input.archived ? Date.now() : null } };
    return team;
  }
  if (method === "orchestration.preflight") return { ready: true, issues: [] };
  if (method === "agents.models") return [{ id: "fixture-model", label: "Fixture model", agent: "codex", efforts: ["medium"], defaultEffort: "medium" }];
  if (method === "system.info") return { harnesses };
  if (method === "app.settings.get") return { defaultPermissionMode: "trusted" };
  if (method === "schedules.list") return [schedule];
  if (method === "schedules.update") {
    schedule = { ...schedule, ...input.patch, version: schedule.version + 1, updatedAt: schedule.updatedAt + 1 };
    return schedule;
  }
  if (method === "schedules.create") return schedule;
  throw new Error(`Unexpected fixture RPC: ${method}`);
};
queryClient.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } });
useLayout.setState({ projectId: project.id });

function Fixture() {
  const [view, setView] = useState<"orchestration" | "scheduled">("orchestration");
  Object.assign(window, {
    readabilityViews: {
      show(next: "orchestration" | "scheduled") {
        useRouter.setState({ route: next === "orchestration" ? { view: "orchestration", projectId: project.id, teamId: team.team.id } : { view: "scheduled" } });
        setView(next);
      },
      theme(mode: "light" | "dark") {
        useTheme.getState().set(mode);
      },
      calls,
      team: () => team,
      schedule: () => schedule,
    },
  });
  return <QueryClientProvider client={queryClient}>{view === "orchestration" ? <Orchestration projectId={project.id} teamId={team.team.id} /> : <Scheduled />}</QueryClientProvider>;
}
useRouter.setState({ route: { view: "orchestration", projectId: project.id, teamId: team.team.id } });
createRoot(document.getElementById("root")!).render(<Fixture />);
