import { z } from "zod";
import type { Project, ProjectGit } from "./domain.js";

export const projectRpcParams = {
  "workspace.get": z.object({}),
  "workspace.configure": z.object({ entrypoint: z.string().min(1).max(4096) }).strict(),
  "projects.list": z.object({}),
  "projects.get": z.object({ id: z.string() }),
  "projects.git": z.object({ id: z.string() }),
  "projects.checkoutBranch": z.object({ id: z.string() }),
  "projects.import": z.object({ rootPath: z.string(), create: z.boolean().optional() }),
  /** True only when nothing exists at an absolute rootPath yet, so importing it with create makes the folder. */
  "projects.folderMissing": z.object({ rootPath: z.string() }),
  "projects.remove": z.object({ id: z.string().min(1) }).strict(),
  "projects.updateSettings": z.object({
    id: z.string(),
    settings: z.object({ setupScript: z.string().nullable().optional(), worktreeInclude: z.array(z.string()).optional(), branchPrefix: z.string().optional() }),
  }),
};

export interface ProjectRpcResults {
  "workspace.get": Project;
  "workspace.configure": Project;
  "projects.list": Project[];
  "projects.get": Project | null;
  "projects.git": ProjectGit;
  "projects.checkoutBranch": string | null;
  "projects.import": Project;
  "projects.folderMissing": boolean;
  "projects.remove": { ok: true };
  "projects.updateSettings": Project;
}
