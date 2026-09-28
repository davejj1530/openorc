import { describe, expect, it } from "vitest";
import { DEFAULT_TEAM_LIMITS, MAX_TEAM_DEPTH, harnessIds, type Project, type RpcResults, type TeamDetail } from "@openorc/protocol";
import { evaluateNewThreadAvailability, type NewThreadAvailabilityInput } from "./new-thread-availability";

const project: Project = {
  id: "project-1",
  name: "Project",
  rootPath: "/project",
  defaultBranch: "main",
  gitRemote: null,
  settings: { setupScript: null, worktreeInclude: [], branchPrefix: "openorc/", detectedConfigs: [] },
  createdAt: 1,
  updatedAt: 1,
};
const team: TeamDetail = {
  team: { id: "team-1", projectId: project.id, currentRevisionId: "revision-1", archivedAt: null, createdAt: 1, updatedAt: 1 },
  revision: {
    id: "revision-1",
    teamId: "team-1",
    projectId: project.id,
    number: 1,
    name: "Team",
    createdAt: 1,
    limits: { ...DEFAULT_TEAM_LIMITS },
    members: [{ key: "lead", name: "Lead", managerKey: null, responsibility: "Lead", settings: { agent: "codex", model: "codex-model", effort: "medium", fastMode: false } }],
  },
};
const system: RpcResults["system.info"] = {
  dataDir: "/data",
  harnesses: harnessIds.map((id) => ({ id, state: id === "codex" ? "ready" : "sign_in", path: `/bin/${id}`, version: "1", revision: 1 })),
  gh: { installed: false, path: null },
};
const models: RpcResults["agents.models"] = [{ id: "codex-model", label: "Codex", agent: "codex", isDefault: true, efforts: ["medium"], defaultEffort: "medium" }];

function input(): NewThreadAvailabilityInput {
  return {
    projectId: project.id,
    projects: [project],
    projectsFailed: false,
    permissionReady: true,
    target: { kind: "team", revision: team.revision, initialLeadOverrides: {} },
    choice: { agent: "codex", model: "codex-model", effort: "medium", fastMode: false },
    teams: { data: [team], failed: false },
    availability: { data: { enabled: true, reason: null, maxHierarchyDepth: MAX_TEAM_DEPTH }, failed: false },
    models: { data: models, failed: false },
    system: { data: system, failed: false },
  };
}

describe("new thread availability", () => {
  it("keeps a recovered selection visible while blocking a missing or archived team", () => {
    const saved = input();
    expect(evaluateNewThreadAvailability(saved).disabledReason).toBeNull();
    expect(evaluateNewThreadAvailability({ ...saved, teams: { data: [], failed: false } }).targetIssue).toContain("no longer available");
    const archived = { ...team, team: { ...team.team, archivedAt: 2 } };
    const result = evaluateNewThreadAvailability({ ...saved, teams: { data: [archived], failed: false } });
    expect(result.targetIssue).toContain("archived");
    expect(result.teamOptions).toEqual([]);
  });

  it("orders project and permission loading before provider and team failures", () => {
    const saved = input();
    const unavailable = { ...saved, models: { data: [] as RpcResults["agents.models"], failed: false } };
    expect(evaluateNewThreadAvailability(unavailable).disabledReason).toContain("saved model is unavailable");
    expect(evaluateNewThreadAvailability({ ...unavailable, permissionReady: false }).disabledReason).toBe("Loading saved permissions…");
    expect(evaluateNewThreadAvailability({ ...unavailable, projects: [] }).disabledReason).toContain("project is unavailable");
    expect(evaluateNewThreadAvailability({ ...saved, system: { data: { ...system, harnesses: system.harnesses.map((row) => ({ ...row, state: "sign_in" })) }, failed: false } }).targetIssue).toContain(
      "sign in to Codex",
    );
  });

  it("retains an unrestoreable target reason and offers available teams without choosing one", () => {
    const saved = input();
    const result = evaluateNewThreadAvailability({ ...saved, target: { kind: "unavailable", label: "Saved team", reason: "Choose the team again" }, choice: null });
    expect(result.targetIssue).toBe("Choose the team again");
    expect(result.teamOptions).toHaveLength(1);
    expect(result.teamOptions[0]).toMatchObject({ revisionId: team.revision.id, disabledReason: null });
  });

  it("blocks a recovered solo model when its provider or model disappears", () => {
    const saved = input();
    const solo: NewThreadAvailabilityInput = { ...saved, target: { kind: "model", choice: saved.choice } };
    expect(evaluateNewThreadAvailability(solo).disabledReason).toBeNull();
    expect(evaluateNewThreadAvailability({ ...solo, models: { data: [], failed: false } }).disabledReason).toContain("selected model is unavailable");
    const signedOut = { ...system, harnesses: system.harnesses.map((row) => ({ ...row, state: "sign_in" as const })) };
    expect(evaluateNewThreadAvailability({ ...solo, system: { data: signedOut, failed: false } }).disabledReason).toContain("Sign in to Codex");
  });
});
