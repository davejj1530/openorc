import { randomUUID } from "node:crypto";
import { WORKSPACE_ID, type Project, type ProjectSettings } from "@openorc/protocol";
import type { Db } from "./database.js";

const now = () => Date.now();

interface ProjectRow {
  id: string;
  name: string;
  root_path: string;
  git_remote: string | null;
  default_branch: string | null;
  settings: string;
  created_at: number;
  updated_at: number;
}

const defaultSettings: ProjectSettings = { setupScript: null, worktreeInclude: [".env", ".env.*"], branchPrefix: "openorc", detectedConfigs: [] };

function projectFromRow(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    rootPath: r.root_path,
    gitRemote: r.git_remote,
    defaultBranch: r.default_branch,
    settings: { ...defaultSettings, ...(JSON.parse(r.settings) as Partial<ProjectSettings>) },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export const projects = {
  list(db: Db, options: { includeRemoved?: boolean } = {}): Project[] {
    const visible = options.includeRemoved ? "" : " AND removed_at IS NULL";
    return (db.stmt(`SELECT * FROM projects WHERE id != ?${visible} ORDER BY updated_at DESC`).all(WORKSPACE_ID) as unknown as ProjectRow[]).map(projectFromRow);
  },
  get(db: Db, id: string): Project | null {
    const r = db.stmt("SELECT * FROM projects WHERE id = ?").get(id) as unknown as ProjectRow | undefined;
    return r ? projectFromRow(r) : null;
  },
  getByRoot(db: Db, rootPath: string): Project | null {
    const r = db.stmt("SELECT * FROM projects WHERE root_path = ?").get(rootPath) as unknown as ProjectRow | undefined;
    return r ? projectFromRow(r) : null;
  },
  /** Listing membership only. Records stay readable for existing work and history. */
  setListed(db: Db, id: string, listed: boolean): boolean {
    if (id === WORKSPACE_ID) {
      if (!listed) throw new Error("Workspace cannot be removed");
      return false;
    }
    if (!projects.get(db, id)) throw new Error(`project ${id} not found`);
    const t = now();
    const condition = listed ? "removed_at IS NOT NULL" : "removed_at IS NULL";
    const result = db.stmt(`UPDATE projects SET removed_at = ?, updated_at = ? WHERE id = ? AND ${condition}`).run(listed ? null : t, t, id);
    return result.changes > 0;
  },
  insert(db: Db, p: { name: string; rootPath: string; gitRemote: string | null; defaultBranch: string | null; settings: Partial<ProjectSettings> }): Project {
    const id = randomUUID();
    const t = now();
    db.stmt("INSERT INTO projects (id, name, root_path, git_remote, default_branch, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      id,
      p.name,
      p.rootPath,
      p.gitRemote,
      p.defaultBranch,
      JSON.stringify({ ...defaultSettings, ...p.settings }),
      t,
      t,
    );
    return projects.get(db, id) as Project;
  },
  updateSettings(db: Db, id: string, patch: Partial<ProjectSettings>): Project {
    const current = projects.get(db, id);
    if (!current) throw new Error(`project ${id} not found`);
    db.stmt("UPDATE projects SET settings = ?, updated_at = ? WHERE id = ?").run(JSON.stringify({ ...current.settings, ...patch }), now(), id);
    return projects.get(db, id) as Project;
  },
};
