import { z } from "zod";
import type { Route } from "./wire.js";

const environment = z.object({ variables: z.array(z.object({ name: z.string().min(1), updatedAt: z.iso.datetime() })), canChange: z.boolean() });
export type WireEnvironment = z.infer<typeof environment>;

/** The server's refusal of one variable's name: nothing of the save was kept, and `message` belongs under that row. */
export class EnvironmentNameRefused extends Error {
  constructor(
    readonly variable: string,
    message: string,
  ) {
    super(message);
  }
}
const nameRefusal = z.object({ code: z.literal("environment_name_refused"), name: z.string(), message: z.string().min(1).max(200) });
const refusal = (status: number, body: unknown) => {
  const parsed = status === 400 ? nameRefusal.safeParse(body) : null;
  return parsed?.success ? new EnvironmentNameRefused(parsed.data.name, parsed.data.message) : undefined;
};

const of = (projectId: string) => `/hosted/projects/${encodeURIComponent(projectId)}/environment`;

/** A cloud project's own environment variables: names and times to read, values to set, one name to remove. */
export const ENVIRONMENT_ROUTES = {
  read: (projectId: string): Route<WireEnvironment> => ({ method: "GET", path: of(projectId), reply: environment }),
  set: (projectId: string): Route<WireEnvironment> => ({ method: "PUT", path: of(projectId), reply: environment, refusal }),
  remove: (projectId: string, name: string): Route<WireEnvironment> => ({ method: "DELETE", path: `${of(projectId)}/${encodeURIComponent(name)}`, reply: environment }),
};
