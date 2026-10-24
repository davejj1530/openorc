import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeNewThreadDraft, newThreadStartInput } from "@openorc/client";
import { DEFAULT_TEAM_LIMITS, type TeamRevision } from "@openorc/protocol";
import { readNewThreadDraft, teamDepth, teamLaunchRequest, writeNewThreadDraft } from "./new-thread-draft";

const revision: TeamRevision = {
  id: "revision-1",
  teamId: "team-1",
  projectId: "project-1",
  number: 1,
  name: "Delivery team",
  createdAt: 1,
  limits: { ...DEFAULT_TEAM_LIMITS },
  members: [
    { key: "lead", name: "Lead", managerKey: null, responsibility: "Delegate and integrate", settings: { agent: "codex", model: "fixture-lead", effort: "medium", fastMode: false } },
    { key: "worker", name: "Worker", managerKey: "lead", responsibility: "Implement the change", settings: { agent: "claude", model: "fixture-worker", effort: "high", fastMode: false } },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe("new task execution drafts", () => {
  it("measures a team's depth from its lead", () => {
    expect(teamDepth(revision)).toBe(2);
    expect(teamDepth({ ...revision, members: revision.members.map((member) => ({ ...member, managerKey: member.key === "lead" ? "worker" : "lead" })) })).toBe(Infinity);
  });

  it("migrates the existing prompt and keeps attachment storage and other projects separate", () => {
    const storage = new Map<string, string>([
      ["openorc.draft.new", JSON.stringify({ "project-1": "Legacy request", "project-2": "Other request" })],
      ["openorc.draft.newthread.project-1.attachments", JSON.stringify({ attachments: [{ path: "/image.png", url: "image://local", name: "Image" }] })],
    ]);
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    const draft = readNewThreadDraft("project-1");
    expect(draft.prompt).toBe("Legacy request");
    expect(writeNewThreadDraft({ ...draft, target: { kind: "team", revision, initialLeadOverrides: { fastMode: true } } })).toBe(true);
    expect(readNewThreadDraft("project-1").target).toEqual({ kind: "team", revision, initialLeadOverrides: { fastMode: true } });
    expect(readNewThreadDraft("project-2").prompt).toBe("Other request");
    expect(JSON.parse(storage.get("openorc.draft.newthread.project-1.attachments")!)).toEqual({ attachments: [{ path: "/image.png", url: "image://local", name: "Image" }] });
    expect(writeNewThreadDraft({ ...draft, prompt: "" })).toBe(true);
    expect(readNewThreadDraft("project-1").prompt).toBe("");
  });

  it.each(["current", "worktree"] as const)("sends and persists the %s selection for teams and solo conversations", (workspace) => {
    const team = decodeNewThreadDraft("project-1", { projectId: "project-1", target: { kind: "team", revision }, workspace });
    const input = { permissionMode: "trusted" as const, workspaceMode: workspace, prompt: "Start here", attachments: [] };
    const payload = newThreadStartInput(team, input);
    expect(payload).toMatchObject({ workspaceMode: workspace, executionTarget: { kind: "team", teamRevisionId: revision.id } });
    const restored = decodeNewThreadDraft("project-1", JSON.parse(JSON.stringify(team)));
    expect(newThreadStartInput(restored, { ...input, workspaceMode: restored.workspace! })).toEqual(payload);
    const request = teamLaunchRequest(null, JSON.stringify(payload));
    expect(teamLaunchRequest(request, JSON.stringify(newThreadStartInput(team, { ...input, workspaceMode: workspace === "current" ? "worktree" : "current" }))).key).not.toBe(request.key);
    const solo = { ...team, target: { kind: "model" as const, choice: revision.members[0]!.settings } };
    expect(newThreadStartInput(solo, input)).toMatchObject({ workspaceMode: workspace, agent: "codex", model: "fixture-lead" });
  });

  it("keeps the launch key across reload for the same payload and replaces it for changed or completed work", () => {
    const request = teamLaunchRequest(null, "revision + prompt + images + permissions");
    const restored = decodeNewThreadDraft("project-1", JSON.parse(JSON.stringify({ projectId: "project-1", target: { kind: "team", revision }, launchRequest: request })));
    expect(teamLaunchRequest(restored.launchRequest, request.fingerprint)).toEqual(request);
    expect(teamLaunchRequest(restored.launchRequest, "changed image or permission").key).not.toBe(request.key);
    expect(teamLaunchRequest(null, request.fingerprint).key).not.toBe(request.key);
  });
});
