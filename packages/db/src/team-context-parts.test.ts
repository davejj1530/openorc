import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TEAM_LIMITS } from "@openorc/protocol";
import { Db } from "./database.js";
import { orchestration } from "./orchestration.js";
import { projects, threads } from "./repos.js";
import { teamContexts } from "./team-context.js";
import { storedReferences, teamContextParts } from "./team-context-parts.js";

const opened = new Set<Db>();
afterEach(() => {
  for (const db of opened) db.close();
  opened.clear();
});
const settings = { agent: "codex" as const, model: "fixture", effort: null, fastMode: false };
function fixture() {
  const db = Db.memory();
  opened.add(db);
  const project = projects.insert(db, { name: "Parts", rootPath: `/tmp/${randomUUID()}`, defaultBranch: "main", gitRemote: null, settings: {} });
  const saved = orchestration.save(db, {
    projectId: project.id,
    expectedRevisionId: null,
    draft: { name: "Parts team", limits: DEFAULT_TEAM_LIMITS, members: [{ key: "lead", name: "Lead", managerKey: null, responsibility: "Work", settings }] },
  });
  const instance = () =>
    orchestration.createInstance(db, {
      threadId: threads.insert(db, { projectId: project.id, title: "Parts", ...settings, mode: "act", permissionMode: "trusted" }).id,
      teamRevisionId: saved.revision.id,
    });
  return { db, source: instance(), target: instance() };
}

describe("stored context parts", () => {
  it("stores text once by content, immutable and scoped to its instance", () => {
    const { db, source, target } = fixture();
    const first = teamContextParts.put(db, source.id, "漢字 requirement");
    expect(first).toMatchObject({ instanceId: source.id, bytes: Buffer.byteLength("漢字 requirement"), content: "漢字 requirement" });
    expect(first.id).toMatch(/^[0-9a-f]{64}$/);
    expect(teamContextParts.put(db, source.id, "漢字 requirement")).toEqual(first);
    expect(db.stmt("SELECT COUNT(*) AS n FROM team_context_parts").get()).toEqual({ n: 1 });
    expect(teamContextParts.get(db, target.id, first.id)).toBeNull();
    expect(teamContextParts.get(db, source.id, "not-an-id")).toBeNull();
    expect(() => teamContextParts.put(db, source.id, "")).toThrow(/empty/);
    expect(() => db.stmt("UPDATE team_context_parts SET content='changed'").run()).toThrow(/immutable/);
    // Unreferenced text may go; referenced text is held by the schema until its instance releases it.
    db.stmt("DELETE FROM team_context_parts WHERE id=?").run(first.id);
    const held = teamContextParts.put(db, source.id, "漢字 requirement");
    teamContexts.create(db, {
      instanceId: source.id,
      executionId: null,
      actorId: "lead",
      originExecutionId: null,
      reason: "compact",
      requestKey: "hold",
      seed: JSON.stringify({ stored: held.id, bytes: held.bytes }),
    });
    expect(() => db.stmt("DELETE FROM team_context_parts").run()).toThrow(/still referenced/);
    expect(() => db.stmt("INSERT INTO team_context_parts(instance_id,id,bytes,content,created_at) VALUES(?,?,?,?,?)").run(source.id, "a".repeat(64), 3, "four", 1)).toThrow(/CHECK/);
  });

  it("finds stored references at any depth and adopts them transitively for a fork", () => {
    const { db, source, target } = fixture();
    const inner = teamContextParts.put(db, source.id, "The original 40 KiB instruction");
    const outer = teamContextParts.put(db, source.id, JSON.stringify([{ originalInstruction: { stored: inner.id, bytes: inner.bytes, preview: "The…" } }]));
    const seed = JSON.stringify({ canonical: { count: 1, stored: outer.id, bytes: outer.bytes, preview: "[…" }, plain: { stored: "not a part", bytes: 1 }, ignored: { stored: inner.id } });
    expect(storedReferences(seed)).toEqual([outer.id]);
    expect(storedReferences("not json")).toEqual([]);
    expect(teamContextParts.adopt(db, { from: source.id, to: target.id, seed })).toEqual([outer.id, inner.id]);
    expect(teamContextParts.get(db, target.id, inner.id)?.content).toBe("The original 40 KiB instruction");
    expect(teamContextParts.adopt(db, { from: source.id, to: target.id, seed })).toEqual([outer.id, inner.id]);
    expect(db.stmt("SELECT COUNT(*) AS n FROM team_context_parts WHERE instance_id=?").get(target.id)).toEqual({ n: 2 });
    const missing = JSON.stringify({ stored: createHash("sha256").update("never stored under source").digest("hex"), bytes: 1 });
    expect(() => teamContextParts.adopt(db, { from: source.id, to: target.id, seed: missing })).toThrow(/no longer holds/);
  });
});
