import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { Db } from "./database.js";
import { projects, runs, threads } from "./repos.js";
import { subagents } from "./subagents.js";

it("pages a large native-agent forest without rescanning every child for each parent", () => {
  const db = Db.memory();
  try {
    const project = projects.insert(db, { name: "History", rootPath: "/repo", gitRemote: null, defaultBranch: null, settings: {} });
    const insert = db.stmt(`INSERT INTO threads (id, project_id, title, agent, mode, permission_mode, created_at, updated_at, last_activity_at, parent_thread_id, parent_relation)
      VALUES (?, ?, 'Thread', 'codex', 'act', 'autonomous', 1, 1, ?, ?, ?)`);
    db.transaction(() => {
      for (let i = 0; i < 12_000; i++) insert.run(`t${i}`, project.id, i, i % 5 ? `t${i - (i % 5)}` : null, i % 5 ? "subagent" : null);
    });
    const start = performance.now();
    const page = threads.list(db, { projectId: project.id, includeChildren: true, orderBy: "activity", limit: 13 });
    const duration = performance.now() - start;
    expect(page).toHaveLength(65);
    expect(page[0]?.id).toBe("t11999");
    // Indexed traversal is tens of milliseconds; the accidental relation-only scan took five seconds.
    expect(duration).toBeLessThan(500);
  } finally {
    db.close();
  }
});

function forest() {
  const db = Db.memory();
  const project = projects.insert(db, { name: "Pages", rootPath: "/repo", gitRemote: null, defaultBranch: null, settings: {} });
  const insert = (id: string, parent: string | null, createdAt: number, relation = "subagent") => {
    db.stmt(
      `INSERT INTO threads (id, project_id, title, agent, mode, permission_mode, created_at, updated_at, last_activity_at, parent_thread_id, parent_relation)
      VALUES (?, ?, ?, 'codex', 'act', 'autonomous', ?, 1, ?, ?, ?)`,
    ).run(id, project.id, id, createdAt, 1_000 - createdAt, parent, parent ? relation : null);
  };
  insert("root", null, 0);
  for (let i = 1; i <= 100; i++) insert(`c${i}`, "root", i);
  for (let i = 1; i <= 20; i++) insert(`g${i}`, "c1", i);
  const page = (extra: Parameters<typeof threads.list>[1] = {}) => threads.list(db, { projectId: project.id, includeChildren: true, limit: 12, ...extra });
  return { db, insert, page };
}

it("omits hidden children from the server payload, with a hidden count per parent and cumulative pages", () => {
  const { db, page } = forest();
  try {
    const first = page();
    expect(first.map((row) => row.id).sort()).toEqual(["c100", "c96", "c97", "c98", "c99", "root"]);
    expect(first.find((row) => row.id === "root")).toMatchObject({ hiddenChildren: 95, treeActivityAt: 1_000 });
    const next = page({ childLimits: { root: 17 } });
    expect(next).toHaveLength(18);
    expect(next.find((row) => row.id === "root")?.hiddenChildren).toBe(83);
    expect(next.some((row) => row.id === "g20")).toBe(false);
    expect(page({ includeChildren: false, excludeSubagents: true })).toHaveLength(1);
  } finally {
    db.close();
  }
});

it.each(["selected", "search", "working", "waiting"] as const)("retains the older %s child and its ancestors at each depth", (reason) => {
  const { db, page } = forest();
  try {
    if (reason === "working") {
      for (const id of ["root", "g1"]) runs.insert(db, { id: `${id}-run`, threadId: id, taskId: null, agent: "codex", model: null, mode: "act", permissionMode: "autonomous" });
      subagents.insert(db, {
        threadId: "g1",
        runId: "g1-run",
        hostRunId: "root-run",
        rootThreadId: "root",
        nativeId: "native",
        toolCallId: "tool",
        taskId: null,
        agentType: "explore",
        prompt: "work",
        status: "running",
        result: null,
        startedAt: 1,
        endedAt: null,
      });
    }
    const queries = { selected: { selectedId: "g1" }, search: { childSearch: "g1" }, waiting: { attentionIds: ["g1"] }, working: {} };
    const rows = page(queries[reason]);
    expect(rows.map((row) => row.id)).toEqual(expect.arrayContaining(["root", "c1", "g1"]));
    expect(rows.find((row) => row.id === "root")?.hiddenChildren).toBe(94);
    // g1 also matches g10..g19; all matching rows must be included.
    expect(rows.find((row) => row.id === "c1")?.hiddenChildren).toBe(reason === "search" ? 8 : 14);
    expect(rows.some((row) => row.id === "c2")).toBe(false);
    expect(rows.some((row) => row.id === "g2")).toBe(false);
  } finally {
    db.close();
  }
});

it("breaks equal start times by id and pages each parent independently", () => {
  const { db, insert, page } = forest();
  try {
    insert("a-tie", "root", 100);
    insert("z-tie", "root", 100);
    const rows = page({ selectedId: "c1", childLimits: { c1: 17 } });
    expect(rows.map((row) => row.id)).toEqual(expect.arrayContaining(["a-tie", "c100", "z-tie", "c99", "c98", "c1", "g4"]));
    expect(rows.find((row) => row.id === "root")?.hiddenChildren).toBe(96);
    expect(rows.find((row) => row.id === "c1")?.hiddenChildren).toBe(3);
    expect(rows.some((row) => row.id === "c97")).toBe(false);
  } finally {
    db.close();
  }
});

it("finds hidden Unicode titles with the same casing rules as the sidebar", () => {
  const { db, page } = forest();
  try {
    db.stmt("UPDATE threads SET title = 'École · Проверка' WHERE id = 'g1'").run();
    for (const childSearch of ["école", "проверка"]) expect(page({ childSearch }).map((row) => row.id)).toEqual(expect.arrayContaining(["root", "c1", "g1"]));
  } finally {
    db.close();
  }
});
