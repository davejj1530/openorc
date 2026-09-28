import { listSkills } from "@openorc/agents";
import { Db, projects } from "@openorc/db";
import { FileService } from "../services/files.js";
import { taskAndProject, threadAndProject } from "./context.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  db: Db;
  files: Pick<FileService, "search" | "read">;
};

export function createFilesHandlers({ db, files }: Dependencies): Pick<Handlers, "skills.list" | "files.search" | "files.read"> {
  return {
    "skills.list": ({ projectId, agent }) => {
      const project = projects.get(db, projectId);
      if (!project) throw new Error(`project ${projectId} not found`);
      return listSkills({ projectRoot: project.rootPath, agent });
    },
    "files.search": ({ projectId, query, limit }) => {
      const project = projects.get(db, projectId);
      if (!project) throw new Error(`project ${projectId} not found`);
      return files.search(project, query, limit);
    },
    "files.read": ({ scope, path }) => {
      if (scope.kind === "thread") {
        const { thread, project } = threadAndProject(db, scope.id);
        return files.read(thread.worktreePath ?? project.rootPath, path);
      }
      const { task, project } = taskAndProject(db, scope.id);
      return files.read(task.worktreePath ?? project.rootPath, path);
    },
  };
}
