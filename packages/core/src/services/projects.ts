import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { audit, projects, type Db } from "@openorc/db";
import { isGitRepo, repoInfo } from "@openorc/git";
import type { Project, ProjectSettings } from "@openorc/protocol";
import { directory } from "./workspace-home.js";

/** Config files from other tools that tell us how this repo likes its worktrees. */
const knownConfigs = [".worktreeinclude", ".cursor/worktrees.json", ".conductor/settings.toml", ".superset/config.json", ".codex", ".claude/settings.json", ".openorc.json"];

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export class ProjectService {
  constructor(private readonly db: Db) {}

  list(): Project[] {
    return projects.list(this.db);
  }

  get(id: string): Project | null {
    return projects.get(this.db, id);
  }

  /** Any folder can be a project. A folder inside a repository brings the whole repository, as it always has. */
  async import(rootPath: string): Promise<Project> {
    const folder = await directory(rootPath);
    const info = (await isGitRepo(folder)) ? await repoInfo(folder) : null;
    const root = info?.root ?? folder;
    const existing = projects.getByRoot(this.db, root);
    if (existing) {
      if (!projects.setListed(this.db, existing.id, true)) return existing;
      audit.record(this.db, { actor: "user", action: "project.restore", resourceType: "project", resourceId: existing.id });
      return projects.get(this.db, existing.id)!;
    }

    const detected: string[] = [];
    for (const c of knownConfigs) if (await exists(path.join(root, c))) detected.push(c);

    const settings: Partial<ProjectSettings> = { detectedConfigs: detected };
    if (detected.includes(".worktreeinclude")) {
      const lines = (await readFile(path.join(root, ".worktreeinclude"), "utf8"))
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("#"));
      if (lines.length > 0) settings.worktreeInclude = lines;
    }

    const project = projects.insert(this.db, {
      name: path.basename(root),
      rootPath: root,
      gitRemote: info?.remoteUrl ?? null,
      defaultBranch: info?.defaultBranch ?? null,
      settings,
    });
    audit.record(this.db, { actor: "user", action: "project.import", resourceType: "project", resourceId: project.id, metadata: { rootPath: root, detected } });
    return project;
  }

  remove(id: string): void {
    if (projects.setListed(this.db, id, false)) audit.record(this.db, { actor: "user", action: "project.remove", resourceType: "project", resourceId: id });
  }

  updateSettings(id: string, patch: Partial<ProjectSettings>): Project {
    const p = projects.updateSettings(this.db, id, patch);
    audit.record(this.db, { actor: "user", action: "project.settings", resourceType: "project", resourceId: id, metadata: patch });
    return p;
  }
}
