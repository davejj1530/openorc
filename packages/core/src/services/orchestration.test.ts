import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Db, projects, tasks, threads } from "@openorc/db";
import { rpcParams, type ModelOption, type Project, type TeamDraft, type ExecutableAgent } from "@openorc/protocol";
import { OrchestrationService } from "./orchestration.js";

type Provider = ExecutableAgent;

function draft(): TeamDraft {
  return {
    name: "Delivery team",
    members: [
      { key: "lead", name: "Lead", responsibility: "Scope and integrate the work", managerKey: null, settings: { agent: "codex", model: "fixture-astra", effort: "high", fastMode: true } },
      {
        key: "reviewer",
        name: "Reviewer",
        responsibility: "Review the combined changes",
        managerKey: "lead",
        settings: { agent: "claude", model: "fixture-fable", effort: "medium", fastMode: false },
      },
      { key: "ui", name: "UI engineer", responsibility: "Implement the interface", managerKey: "lead", settings: { agent: "codex", model: "fixture-sol", effort: "medium", fastMode: false } },
      { key: "core", name: "Core engineer", responsibility: "Implement the domain behavior", managerKey: "lead", settings: { agent: "codex", model: "fixture-sol", effort: "high", fastMode: false } },
      { key: "verify", name: "Verification engineer", responsibility: "Verify the result", managerKey: "lead", settings: { agent: "codex", model: "fixture-sol", effort: null, fastMode: false } },
    ],
    limits: { maxConcurrentAgents: 3, maxAssignments: 20, maxExecutionMinutes: 60, maxAttemptsPerAssignment: 2 },
  };
}

const modelCatalog: Record<Provider, ModelOption[]> = {
  codex: [
    { id: "fixture-astra", label: "Fixture Astra", agent: "codex", isDefault: true, efforts: ["medium", "high"], defaultEffort: "medium", fastMode: { supported: true } },
    {
      id: "fixture-sol",
      label: "Fixture Sol",
      agent: "codex",
      isDefault: false,
      efforts: ["medium", "high"],
      defaultEffort: "medium",
      fastMode: { supported: false, reason: "Fast is unavailable for this model" },
    },
  ],
  claude: [{ id: "fixture-fable", label: "Fixture Fable", agent: "claude", isDefault: true, efforts: ["medium", "high"], defaultEffort: "medium", fastMode: { supported: false } }],
  opencode: [
    {
      id: "openrouter/acme/fast",
      label: "Acme Fast",
      agent: "opencode",
      provider: { id: "openrouter", label: "OpenRouter" },
      isDefault: true,
      efforts: [],
      defaultEffort: null,
      fastMode: { supported: false },
    },
  ],
};

let db: Db;
let project: Project;
let service: OrchestrationService;
const invalidate = vi.fn<(keys: string[]) => void>();
const models = vi.fn<(agent: Provider) => Promise<ModelOption[]>>();
const status = vi.fn<(agent: Provider) => Promise<{ installed: boolean; loggedIn: boolean | null }>>();

beforeEach(() => {
  db = Db.memory();
  project = projects.insert(db, { name: "Project", rootPath: "/fixture/orchestration/no-workspace", gitRemote: null, defaultBranch: "main", settings: {} });
  invalidate.mockReset();
  models.mockReset().mockImplementation(async (agent) => structuredClone(modelCatalog[agent]));
  status.mockReset().mockResolvedValue({ installed: true, loggedIn: true });
  service = new OrchestrationService(db, { models, status }, invalidate);
});

afterEach(() => db.close());

describe("saved orchestration teams", () => {
  it("saves, reopens and checks readiness for OpenRouter alongside Codex and Claude", async () => {
    const mixed = draft();
    mixed.members[2]!.settings = { agent: "opencode", model: "openrouter/acme/fast", effort: null, fastMode: false };
    const saved = service.save({ projectId: project.id, expectedRevisionId: null, draft: mixed });
    expect(service.get(saved.team.id)?.revision.members).toEqual(mixed.members);
    expect(await service.preflight({ projectId: project.id, draft: mixed })).toEqual({ ready: true, issues: [] });
    expect(models.mock.calls.map(([agent]) => agent).sort()).toEqual(["claude", "codex", "opencode"]);
    models.mockImplementation(async (agent) => (agent === "opencode" ? [] : structuredClone(modelCatalog[agent])));
    expect(await service.preflight({ projectId: project.id, draft: mixed })).toMatchObject({ ready: false, issues: [{ memberKey: "ui", code: "model_unavailable" }] });
    expect(service.get(saved.team.id)?.revision.members).toEqual(mixed.members);
  });

  it("rejects an unknown project before saving or probing a provider", async () => {
    expect(() => service.save({ projectId: "missing", expectedRevisionId: null, draft: draft() })).toThrow(/project/i);
    await expect(service.preflight({ projectId: "missing", draft: draft() })).rejects.toThrow(/project/i);
    expect(service.list(project.id)).toEqual([]);
    expect(invalidate).not.toHaveBeenCalled();
    expect(models).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it("creates a new revision without overwriting a competing editor's saved changes", () => {
    const first = service.save({ projectId: project.id, expectedRevisionId: null, draft: draft() });
    const secondDraft = { ...draft(), name: "Delivery and review" };
    const second = service.save({ projectId: project.id, teamId: first.team.id, expectedRevisionId: first.revision.id, draft: secondDraft });
    invalidate.mockClear();

    expect(() => service.save({ projectId: project.id, teamId: first.team.id, expectedRevisionId: first.revision.id, draft: { ...draft(), name: "Stale edit" } })).toThrow();
    expect(service.get(first.team.id)?.revision).toMatchObject({ id: second.revision.id, number: 2, name: "Delivery and review" });
    expect(first.revision.name).toBe("Delivery team");
    expect(second.team.id).toBe(first.team.id);
    expect(second.revision.id).not.toBe(first.revision.id);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("scopes list and mutations to the selected project", () => {
    const other = projects.insert(db, { name: "Other", rootPath: "/fixture/orchestration/other", gitRemote: null, defaultBranch: "main", settings: {} });
    const saved = service.save({ projectId: project.id, expectedRevisionId: null, draft: draft() });
    invalidate.mockClear();

    expect(service.list(other.id)).toEqual([]);
    expect(() => service.save({ projectId: other.id, teamId: saved.team.id, expectedRevisionId: saved.revision.id, draft: draft() })).toThrow();
    expect(() => service.archive({ projectId: other.id, teamId: saved.team.id, expectedRevisionId: saved.revision.id, archived: true })).toThrow();
    expect(service.get(saved.team.id)?.team.archivedAt).toBeNull();
    expect(service.get("missing")).toBeNull();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("archives and restores selection without losing the saved revision", () => {
    const saved = service.save({ projectId: project.id, expectedRevisionId: null, draft: draft() });
    const archived = service.archive({ projectId: project.id, teamId: saved.team.id, expectedRevisionId: saved.revision.id, archived: true });

    expect(archived.team.archivedAt).not.toBeNull();
    expect(service.list(project.id)).toEqual([]);
    expect(service.list(project.id, true).map((detail) => detail.team.id)).toEqual([saved.team.id]);
    expect(service.get(saved.team.id)?.revision).toEqual(saved.revision);

    const restored = service.archive({ projectId: project.id, teamId: saved.team.id, expectedRevisionId: saved.revision.id, archived: false });
    expect(restored.team.archivedAt).toBeNull();
    expect(service.list(project.id).map((detail) => detail.team.id)).toEqual([saved.team.id]);
    expect(invalidate).toHaveBeenCalledTimes(3);
    expect(models).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    expect(tasks.list(db)).toEqual([]);
    expect(threads.list(db)).toEqual([]);
  });

  it.each([
    {
      label: "a manager outside the team",
      change: (value: TeamDraft) => {
        value.members[1]!.managerKey = "missing";
      },
    },
  ])("rejects $label before changing saved configuration", ({ change }) => {
    const saved = service.save({ projectId: project.id, expectedRevisionId: null, draft: draft() });
    const invalid = draft();
    change(invalid);
    invalidate.mockClear();

    expect(() => service.save({ projectId: project.id, teamId: saved.team.id, expectedRevisionId: saved.revision.id, draft: invalid })).toThrow();
    expect(service.get(saved.team.id)?.revision).toEqual(saved.revision);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("accepts a lead, manager and workers as distinct saved responsibilities", () => {
    const hierarchy = draft();
    hierarchy.members[2]!.managerKey = "reviewer";
    hierarchy.members[3]!.managerKey = "reviewer";
    const saved = service.save({ projectId: project.id, expectedRevisionId: null, draft: hierarchy });

    expect(
      service
        .get(saved.team.id)
        ?.revision.members.filter((member) => member.managerKey === "reviewer")
        .map((member) => member.key),
    ).toEqual(["ui", "core"]);
    expect(tasks.list(db)).toEqual([]);
    expect(threads.list(db)).toEqual([]);
  });

  it("rejects a provider without an executable adapter at the public save boundary", () => {
    const invalid = draft();
    const lead = invalid.members[0]!;
    const input = JSON.parse(
      JSON.stringify({ projectId: project.id, expectedRevisionId: null, draft: { ...invalid, members: [{ ...lead, settings: { ...lead.settings, agent: "acp" } }, ...invalid.members.slice(1)] } }),
    );

    expect(() => service.save(input)).toThrow();
    expect(service.list(project.id)).toEqual([]);
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe("member avatar files", () => {
  it("copies a selected image into managed storage and deletes it on reset", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openorc-avatar-service-"));
    try {
      const dataDir = join(directory, "user-data");
      const source = join(directory, "selected image.png");
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      await writeFile(source, bytes);
      const managedService = new OrchestrationService(db, { models, status }, invalidate, { dataDir });
      const saved = managedService.save({ projectId: project.id, expectedRevisionId: null, draft: draft() });
      const original = managedService.memberAvatars(saved.team.id).find((item) => item.memberKey === "lead")!;

      const custom = await managedService.setMemberAvatar({
        teamId: saved.team.id,
        memberKey: "lead",
        avatar: { kind: "custom", path: source },
      });

      expect(custom.avatar.kind).toBe("custom");
      if (custom.avatar.kind !== "custom") throw new Error("Expected a custom avatar.");
      expect(isAbsolute(custom.avatar.path)).toBe(true);
      const stored = (db.stmt("SELECT custom_path FROM orchestration_team_member_avatars WHERE team_id = ? AND member_key = 'lead'").get(saved.team.id) as { custom_path: string }).custom_path;
      expect(stored).toMatch(/^team-avatars[\\/]/);
      const managedPath = join(dataDir, stored);
      expect(custom.avatar.path).toBe(managedPath);
      expect(new Uint8Array(await readFile(managedPath))).toEqual(bytes);

      await rm(source);
      expect(new Uint8Array(await readFile(managedPath))).toEqual(bytes);
      const replacementSource = join(directory, "replacement.jpg");
      const replacementBytes = new Uint8Array([0xff, 0xd8, 0xff]);
      await writeFile(replacementSource, replacementBytes);
      const replacement = await managedService.setMemberAvatar({
        teamId: saved.team.id,
        memberKey: "lead",
        avatar: { kind: "custom", path: replacementSource },
      });
      expect(replacement.avatar.kind).toBe("custom");
      if (replacement.avatar.kind !== "custom") throw new Error("Expected a custom avatar.");
      const replacementPath = replacement.avatar.path;
      expect(isAbsolute(replacementPath)).toBe(true);
      expect(new Uint8Array(await readFile(replacementPath))).toEqual(replacementBytes);
      await expect(readFile(managedPath)).rejects.toMatchObject({ code: "ENOENT" });

      const reset = await managedService.resetMemberAvatar({ teamId: saved.team.id, memberKey: "lead" });
      expect(reset.avatar).toEqual(original.avatar);
      await expect(readFile(replacementPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unsupported custom avatar files before changing the saved choice", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openorc-avatar-validation-"));
    try {
      const source = join(directory, "selected.txt");
      await writeFile(source, "not an image");
      const managedService = new OrchestrationService(db, { models, status }, invalidate, { dataDir: join(directory, "user-data") });
      const saved = managedService.save({ projectId: project.id, expectedRevisionId: null, draft: draft() });
      const original = managedService.memberAvatars(saved.team.id).find((item) => item.memberKey === "lead")!;

      await expect(
        Promise.resolve().then(() =>
          managedService.setMemberAvatar({
            teamId: saved.team.id,
            memberKey: "lead",
            avatar: { kind: "custom", path: source },
          }),
        ),
      ).rejects.toThrow(/PNG|JPEG|GIF|WebP/);

      const oversized = join(directory, "oversized.png");
      await writeFile(oversized, "");
      await truncate(oversized, 32 * 1024 * 1024 + 1);
      await expect(
        Promise.resolve().then(() =>
          managedService.setMemberAvatar({
            teamId: saved.team.id,
            memberKey: "lead",
            avatar: { kind: "custom", path: oversized },
          }),
        ),
      ).rejects.toThrow(/32 MB|too large|exceeds/i);
      expect(managedService.memberAvatars(saved.team.id).find((item) => item.memberKey === "lead")).toEqual(original);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("thread execution selection boundary", () => {
  const common = { projectId: "project", mode: "act", permissionMode: "trusted", prompt: "Implement the request" };
  const target = { kind: "team", teamRevisionId: "revision" };

  it.each([{ agent: "codex" }, { model: "fixture-astra" }, { effort: "high" }, { fastMode: false }])("rejects a team selection combined with flat execution settings %j", (legacy) => {
    expect(rpcParams["threads.start"].safeParse({ ...common, executionTarget: target, ...legacy }).success).toBe(false);
  });

  it("accepts explicit targets and existing model requests separately", () => {
    expect(rpcParams["threads.start"].safeParse({ ...common, executionTarget: target }).success).toBe(true);
    expect(rpcParams["threads.start"].safeParse({ ...common, executionTarget: { kind: "model", settings: draft().members[0]!.settings } }).success).toBe(true);
    expect(rpcParams["threads.start"].safeParse({ ...common, agent: "codex", model: "fixture-astra", effort: "high", fastMode: false }).success).toBe(true);
    expect(rpcParams["threads.start"].safeParse(common).success).toBe(false);
  });

  it("preserves targets for schedules while rejecting unsupported direct run targets", () => {
    const run = { threadId: "thread", agent: "codex", model: "fixture-astra", mode: "act", permissionMode: "trusted", prompt: "Continue" };
    const schedule = {
      projectId: "project",
      title: "Nightly",
      prompt: "Check changes",
      agent: "codex",
      model: "fixture-astra",
      effort: "high",
      mode: "plan",
      permissionMode: "trusted",
      workspaceMode: "worktree",
      everyMinutes: 30,
    };
    expect(rpcParams["runs.start"].safeParse(run).success).toBe(true);
    expect(rpcParams["runs.start"].safeParse({ ...run, executionTarget: target }).success).toBe(false);
    expect(rpcParams["schedules.create"].safeParse(schedule).success).toBe(true);
    expect(rpcParams["schedules.create"].parse({ ...schedule, executionTarget: target }).executionTarget).toEqual(target);
    expect(rpcParams["schedules.update"].parse({ id: "schedule", patch: { executionTarget: target } }).patch.executionTarget).toEqual(target);
    expect(rpcParams["schedules.create"].safeParse({ ...schedule, executionTarget: { kind: "team" } }).success).toBe(false);
  });
});

describe("team readiness", () => {
  it.each([
    { label: "missing provider", value: { installed: false, loggedIn: true }, code: "provider_unavailable" },
    { label: "unknown login", value: { installed: true, loggedIn: null }, code: "login_unknown" },
  ])("reports every affected member for a $label without querying its models", async ({ value, code }) => {
    status.mockImplementation(async (agent) => (agent === "codex" ? value : { installed: true, loggedIn: true }));
    const result = await service.preflight({ projectId: project.id, draft: draft() });

    expect(result.ready).toBe(false);
    expect(result.issues.map((issue) => ({ memberKey: issue.memberKey, code: issue.code }))).toEqual([
      { memberKey: "lead", code },
      { memberKey: "ui", code },
      { memberKey: "core", code },
      { memberKey: "verify", code },
    ]);
    expect(result.issues.every((issue) => issue.message.trim().length > 0)).toBe(true);
    expect(models.mock.calls.map(([agent]) => agent)).toEqual(["claude"]);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("recovers from a failed provider probe without exposing its raw error or changing saved choices", async () => {
    const saved = service.save({ projectId: project.id, expectedRevisionId: null, draft: draft() });
    status.mockImplementation(async (agent) => {
      if (agent === "claude") throw new Error("private-provider-token in stderr");
      return { installed: true, loggedIn: true };
    });
    invalidate.mockClear();
    const unavailable = await service.preflight({ projectId: project.id, draft: draft() });

    expect(unavailable).toMatchObject({ ready: false, issues: [{ memberKey: "reviewer", code: "provider_unavailable" }] });
    expect(JSON.stringify(unavailable)).not.toContain("private-provider-token");
    expect(models.mock.calls.map(([agent]) => agent)).toEqual(["codex"]);
    status.mockResolvedValue({ installed: true, loggedIn: true });
    expect(await service.preflight({ projectId: project.id, draft: draft() })).toEqual({ ready: true, issues: [] });
    expect(service.get(saved.team.id)?.revision).toEqual(saved.revision);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("keeps a catalog failure separate from missing models and retries the catalog on the next check", async () => {
    models.mockImplementation(async (agent) => {
      if (agent === "claude") throw new Error("private-catalog-token in stderr");
      return structuredClone(modelCatalog[agent]);
    });
    const failed = await service.preflight({ projectId: project.id, draft: draft() });

    expect(failed).toMatchObject({ ready: false, issues: [{ memberKey: "reviewer", code: "catalog_unavailable" }] });
    expect(JSON.stringify(failed)).not.toContain("private-catalog-token");
    models.mockImplementation(async (agent) => structuredClone(modelCatalog[agent]));
    expect(await service.preflight({ projectId: project.id, draft: draft() })).toEqual({ ready: true, issues: [] });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("reports unavailable models, unsupported effort and Fast by member without substituting defaults", async () => {
    const choice = draft();
    choice.members[0]!.settings.model = "no-longer-advertised";
    choice.members[2]!.settings.effort = "ultra";
    choice.members[3]!.settings.fastMode = true;
    const saved = service.save({ projectId: project.id, expectedRevisionId: null, draft: choice });
    models.mockImplementation(async (agent) => {
      const catalog = structuredClone(modelCatalog[agent]);
      if (agent === "claude") catalog[0]!.unavailable = "Update the installed CLI to use this model";
      return catalog;
    });
    invalidate.mockClear();

    const result = await service.preflight({ projectId: project.id, draft: choice });

    expect(result.ready).toBe(false);
    expect(result.issues.map((issue) => `${issue.memberKey}:${issue.code}`).sort()).toEqual(["core:fast_unsupported", "lead:model_unavailable", "reviewer:model_unavailable", "ui:effort_unsupported"]);
    expect(service.get(saved.team.id)?.revision).toMatchObject(choice);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
