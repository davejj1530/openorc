import { z } from "zod";

const id = z.string().min(1);
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const TeamTreeCapture = z.object({
  rootPath: id,
  headSha: sha,
  branch: z.string().nullable(),
  treeSha: sha,
  treeRef: id,
  headRef: id,
  indexSha256: z.string().nullable(),
});
export type TeamTreeCapture = z.infer<typeof TeamTreeCapture>;

/** Durable identity of an explicit user recovery request; replaying the key returns the same outcome. */
export const TeamWorkspaceRecovery = z.object({
  requestKey: id.max(200),
  kind: z.enum(["retry-setup", "accept-setup", "retry-integration", "accept-integration"]),
  createdAt: z.number().int(),
});
export type TeamWorkspaceRecovery = z.infer<typeof TeamWorkspaceRecovery>;
export const TeamWorkspaceRecord = z.object({
  id,
  executionId: id,
  actorId: id,
  taskId: id.nullable(),
  parentActorId: id.nullable(),
  path: id,
  source: TeamTreeCapture,
  state: z.enum(["preparing", "ready", "attention"]),
  setupState: z.enum(["pending", "running", "completed", "blocked"]),
  preparedTree: sha.nullable(),
  outputTree: sha.nullable(),
  error: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  /** True when setup rewrote source files; the prepared tree then differs from the captured input. */
  setupChangedSource: z.boolean().optional(),
  /** Explicit acceptance of a source-changing setup as this assignment's input. Immutable once recorded. */
  setupAccepted: z.object({ sourceTree: sha, preparedTree: sha, acceptedAt: z.number().int() }).nullable().optional(),
  /** Earlier blocked setup directories, kept untouched for inspection. Append-only. */
  retired: z
    .array(z.object({ path: id, preparedTree: sha.nullable(), error: z.string().nullable(), retiredAt: z.number().int() }))
    .max(100)
    .optional(),
  recovery: z.array(TeamWorkspaceRecovery).max(100).optional(),
});
export type TeamWorkspaceRecord = z.infer<typeof TeamWorkspaceRecord>;

export const TeamTreeEntry = z.object({ path: id, mode: z.enum(["100644", "100755", "120000"]), oid: sha });
export type TeamTreeEntry = z.infer<typeof TeamTreeEntry>;
export const TeamPublicationRecord = z.object({
  id,
  executionId: id,
  sourceActorId: id,
  targetActorId: id,
  outputTree: sha,
  destinationPath: id,
  before: TeamTreeCapture,
  afterTree: sha.nullable(),
  scratchPath: id,
  state: z.enum(["planned", "publishing", "applied", "conflict", "attention"]),
  entries: z.array(z.object({ path: id, before: TeamTreeEntry.nullable(), after: TeamTreeEntry.nullable() })),
  includedActorIds: z.array(id),
  error: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  /** Paths whose merge could not be resolved automatically; both sides stay in the scratch worktree. */
  conflicts: z.array(id).max(10_000).optional(),
  /** Earlier scratch worktrees kept for inspection after an explicit retry. Append-only. */
  retiredScratchPaths: z.array(id).max(100).optional(),
  recovery: z.array(TeamWorkspaceRecovery).max(100).optional(),
});
export type TeamPublicationRecord = z.infer<typeof TeamPublicationRecord>;
