import { z } from "zod";

const id = z.string().min(1);
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const WorkspaceTreeCapture = z.object({
  rootPath: id,
  headSha: sha,
  branch: z.string().nullable(),
  treeSha: sha,
  treeRef: id,
  headRef: id,
  indexSha256: z.string().nullable(),
});
export type WorkspaceTreeCapture = z.infer<typeof WorkspaceTreeCapture>;

export const WorkspaceTreeEntry = z.object({ path: id, mode: z.enum(["100644", "100755", "120000"]), oid: sha });
export type WorkspaceTreeEntry = z.infer<typeof WorkspaceTreeEntry>;
export const FilePublication = z.object({
  id,
  destinationPath: id,
  before: WorkspaceTreeCapture,
  entries: z.array(z.object({ path: id, before: WorkspaceTreeEntry.nullable(), after: WorkspaceTreeEntry.nullable() })),
});
export type FilePublication = z.infer<typeof FilePublication>;
