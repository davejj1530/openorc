import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { Db } from "./database.js";
import { projects, threads } from "./repos.js";

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
