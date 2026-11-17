import { z } from "zod";
import type { Route } from "./wire.js";

/**
 * The models OpenOrc Cloud runs for the person, per agent: each the agent CLI's own listing on a cloud machine, read
 * with the CLI version that machine runs, in the shape the app's agents package reads the same CLI with on a Mac.
 * An agent with no entry has not been read yet.
 */
const listed = z.object({ agent: z.enum(["claude", "codex", "opencode"]), cliVersion: z.string(), readAt: z.iso.datetime(), listing: z.unknown() });
const models = z.object({ agents: z.array(listed) });
export type WireCloudModels = z.infer<typeof models>;

export const MODEL_ROUTES = {
  read: (): Route<WireCloudModels> => ({ method: "GET", path: "/hosted/models", reply: models }),
};
