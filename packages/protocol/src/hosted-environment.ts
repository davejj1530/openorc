import { z } from "zod";
import { SpaceId } from "./spaces.js";

/**
 * A cloud project's own environment variables, which every turn in its cloud threads runs with. The server keeps the
 * values and never sends one back: a project shows each variable's name and when it was last set.
 */
export const HostedEnvironmentVariable = z.object({ name: z.string(), updatedAt: z.number() });
export type HostedEnvironmentVariable = z.infer<typeof HostedEnvironmentVariable>;

/** A project's variables as the reader may see them, or none where the server keeps no project environment. */
export type HostedEnvironment = { state: "ready"; variables: HostedEnvironmentVariable[]; canChange: boolean } | { state: "unavailable" };

/** A save: kept whole, or refused for one variable's name, which nothing of the save changed. */
export type HostedEnvironmentSave = { state: "saved"; variables: HostedEnvironmentVariable[]; canChange: boolean } | { state: "refused"; name: string; message: string };

const project = { spaceId: SpaceId, projectId: SpaceId };
const variable = z.object({ name: z.string().max(128), value: z.string().max(32 * 1024) }).strict();

/** Window-only: a paired phone neither reads nor changes a project's environment. */
export const hostedEnvironmentRpcParams = {
  /** Whether the space's server keeps projects' environments, so the app offers one. */
  "hostedEnvironment.available": z.object({ spaceId: SpaceId }).strict(),
  "hostedEnvironment.read": z.object(project).strict(),
  "hostedEnvironment.set": z.object({ ...project, variables: z.array(variable).min(1).max(200) }).strict(),
  "hostedEnvironment.remove": z.object({ ...project, name: z.string().min(1).max(128) }).strict(),
  /** What this Mac's project folder's `.env` and `.env.local` hold, for the sheet to fill from. Reads only. */
  "hostedEnvironment.fromFile": z.object({ localProjectId: z.string().min(1) }).strict(),
};
export interface HostedEnvironmentRpcResults {
  "hostedEnvironment.available": boolean;
  "hostedEnvironment.read": HostedEnvironment;
  "hostedEnvironment.set": HostedEnvironmentSave;
  "hostedEnvironment.remove": HostedEnvironment;
  "hostedEnvironment.fromFile": { files: string[]; entries: { name: string; value: string }[] };
}
