import { threadListCompare } from "@openorc/protocol";
import { expect, it } from "vitest";
import { Db } from "./database.js";
import { projects, threads } from "./repos.js";

it("sorts threads as the SQL list does, for every filter and order", () => {
  const db = Db.memory();
  const project = projects.insert(db, { name: "Order", rootPath: "/repo", gitRemote: null, defaultBranch: null, settings: {} });
  const insert = db.stmt(`INSERT INTO threads (id, project_id, title, agent, mode, permission_mode, created_at, updated_at, last_activity_at, pinned_at, done_at, archived_at)
    VALUES (?, ?, 'Thread', 'claude', 'act', 'autonomous', 1, 1, ?, ?, ?, ?)`);
  // Distinct times per column, so SQL leaves no tie open.
  const shuffled = [7, 3, 11, 0, 9, 5, 1, 10, 4, 8, 2, 6];
  shuffled.forEach((n, index) => insert.run(`t${index}`, project.id, 1000 + n * 13, n % 4 === 0 ? 50 + n : null, n % 3 === 0 ? 2000 + n * 7 : null, n % 5 === 0 ? 3000 + n * 11 : null));
  for (const filter of ["active", "done", "archived", "all"] as const)
    for (const orderBy of [undefined, "activity"] as const) {
      const listed = threads.list(db, { filter, ...(orderBy ? { orderBy } : {}) });
      const sorted = [...listed].sort(threadListCompare({ filter, orderBy }));
      expect(
        sorted.map((thread) => thread.id),
        `${filter} ${orderBy ?? "default"}`,
      ).toEqual(listed.map((thread) => thread.id));
      expect(listed.length, `${filter} lists something`).toBeGreaterThan(0);
    }
});
