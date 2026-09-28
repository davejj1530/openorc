import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_TEAM_LIMITS, TeamDetail, type TeamDraft } from "@openorc/protocol";
import { addTeamMember, editorDraft, hasRevisionConflict, promoteTeamLead, removeTeamMember, updateTeamMember } from "./team-editor-draft";

const lead = { key: "lead", name: "Lead", responsibility: "Coordinate", managerKey: null, settings: { agent: "codex" as const, model: "model", effort: null, fastMode: false } };
const worker = { key: "worker", name: "Worker", responsibility: "Build", managerKey: "lead", settings: { ...lead.settings } };
const teamDraft: TeamDraft = { name: "Team", members: [lead, worker], limits: { ...DEFAULT_TEAM_LIMITS }, discussion: { ambientRounds: 0, peerFollowUps: 0, mentionOnly: ["worker"] } };
const detail = TeamDetail.parse({
  team: { id: "team", projectId: "project", currentRevisionId: "r1", archivedAt: null, createdAt: 1, updatedAt: 1 },
  revision: { ...teamDraft, id: "r1", teamId: "team", projectId: "project", number: 1, createdAt: 1 },
});

let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

it("recovers unfinished local team edits but rejects a malformed recovery record", () => {
  const key = "orchestration.project.team";
  const base = editorDraft(key, detail);
  const unfinished = { ...base, draft: { ...base.draft, name: "" } };
  localStorage.setItem(`openorc.draft.${key}`, JSON.stringify(unfinished));
  expect(editorDraft(key, detail).draft.name).toBe("");
  localStorage.setItem(`openorc.draft.${key}`, JSON.stringify({ ...unfinished, draft: { ...unfinished.draft, members: [{ key: "bad" }] } }));
  expect(editorDraft(key, detail)).toEqual(base);
});

it("keeps a dirty draft on a newer revision but lets a clean editor adopt it", () => {
  const state = editorDraft("orchestration.project.team", detail);
  const newer = { ...detail, revision: { ...detail.revision, id: "r2", number: 2 } };
  expect(hasRevisionConflict(state, newer, undefined)).toBe(true);
  expect(hasRevisionConflict(state, newer, { ...newer, revision: { ...newer.revision, number: 3 } })).toBe(false);
});

it("keeps hierarchy and mention-only settings coherent through member changes", () => {
  const renamed = { ...teamDraft, ...updateTeamMember(teamDraft, "worker", { key: "renamed" }) };
  expect(renamed.discussion?.mentionOnly).toEqual(["renamed"]);
  const promoted = { ...renamed, ...promoteTeamLead(renamed, "renamed") };
  expect(promoted.members.map((member) => [member.key, member.managerKey])).toEqual([
    ["lead", "renamed"],
    ["renamed", null],
  ]);
  const removed = { ...teamDraft, ...removeTeamMember(teamDraft, "worker") };
  expect(removed.members).toEqual([lead]);
  expect(removed.discussion?.mentionOnly).toEqual([]);
  const added = addTeamMember(teamDraft, null, "new");
  expect(added?.members?.[2]).toMatchObject({ key: "new", name: "Member 3", managerKey: "lead" });
});
