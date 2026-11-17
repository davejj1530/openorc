import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Db } from "./database.js";
import { projects, threads } from "./repos.js";
import { cloudMoves } from "./thread-relocations.js";

let db: Db;
beforeEach(() => {
  db = Db.memory();
});
afterEach(() => db.close());

describe("this Mac's journal of a thread moving to and from the cloud", () => {
  it("keeps one move under way per thread, through its phases to an end, and remembers why one stopped", () => {
    const move = cloudMoves.begin(db, { threadId: "t1", direction: "to-cloud", projectId: "p1" }, 10);
    expect(move).toMatchObject({ threadId: "t1", direction: "to-cloud", phase: "frozen", step: null, error: null, projectId: "p1" });
    expect(() => cloudMoves.begin(db, { threadId: "t1", direction: "to-mac", projectId: null })).toThrow();
    cloudMoves.set(db, move.id, { phase: "sending", step: "history" }, 20);
    expect(cloudMoves.open(db, "t1")).toMatchObject({ phase: "sending", step: "history", updatedAt: 20 });
    expect(cloudMoves.allOpen(db).map((each) => each.threadId)).toEqual(["t1"]);
    cloudMoves.set(db, move.id, { phase: "abandoned", step: null, error: "The server didn't answer." }, 30);
    expect(cloudMoves.open(db, "t1")).toBeNull();
    expect(cloudMoves.latest(db, "t1")).toMatchObject({ phase: "abandoned", error: "The server didn't answer." });
    // A move again, the other way, once none is under way.
    const back = cloudMoves.begin(db, { threadId: "t1", direction: "to-mac", projectId: null }, 40);
    expect(back.phase).toBe("asking");
    expect(cloudMoves.latest(db, "t1")?.id).toBe(back.id);
    // A phase the direction has none of is refused by the table.
    expect(() => cloudMoves.set(db, back.id, { phase: "sending" })).toThrow();
    cloudMoves.forget(db, "t1");
    expect(cloudMoves.latest(db, "t1")).toBeNull();
  });

  it("hides a thread coming from the cloud while its rows are written, and shows it once they are whole", () => {
    const project = projects.insert(db, { name: "App", rootPath: "/app", gitRemote: null, defaultBranch: "main", settings: {} });
    const move = cloudMoves.begin(db, { threadId: "t2", direction: "to-mac", projectId: project.id });
    threads.insert(db, { id: "t2", projectId: project.id, title: "From the cloud", agent: "claude", model: null, mode: "act", permissionMode: "trusted", workspaceMode: "worktree" });
    const listed = () => threads.list(db, {}).map((thread) => thread.id);
    expect(listed()).toEqual([]);
    cloudMoves.set(db, move.id, { phase: "received" });
    expect(listed()).toEqual(["t2"]);
  });
});
