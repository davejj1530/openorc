import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Db } from "./database.js";
import { migrations } from "./schema.js";
import { projects, threads } from "./repos.js";

it("migrates existing conversation messages and retains attachment references after reopening", () => {
  const dir = mkdtempSync(join(tmpdir(), "thread-images-db-"));
  const file = join(dir, "test.sqlite");
  const beforeAttachments = migrations.findIndex((m) => typeof m === "string" && m.includes("ALTER TABLE thread_messages ADD COLUMN attachments"));
  const raw = new DatabaseSync(file);
  for (const migration of migrations.slice(0, beforeAttachments)) typeof migration === "string" ? raw.exec(migration) : migration(raw);
  raw.exec(`PRAGMA user_version = ${beforeAttachments}`);
  let db = new Db(raw);
  try {
    const project = projects.insert(db, { name: "Images", rootPath: dir, gitRemote: null, defaultBranch: "main", settings: {} });
    const thread = threads.insert(db, { projectId: project.id, title: "Slack", agent: "codex", model: null, mode: "act", permissionMode: "review" });
    // Reproduce the database immediately before the additive attachments migration.

    db.stmt("INSERT INTO thread_messages (id, thread_id, role, text, created_at) VALUES (?, ?, ?, ?, ?)").run("old", thread.id, "user", "Reference", 1);
    db.close();
    db = Db.open(file);
    expect(db.stmt("SELECT text, attachments FROM thread_messages WHERE id = 'old'").get()).toEqual({ text: "Reference", attachments: null });
    db.stmt("UPDATE thread_messages SET attachments = ? WHERE id = 'old'").run(JSON.stringify(["/images/reference.png"]));
    db.close();
    db = Db.open(file);
    expect(JSON.parse(String(db.stmt("SELECT attachments FROM thread_messages WHERE id = 'old'").get()!.attachments))).toEqual(["/images/reference.png"]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
