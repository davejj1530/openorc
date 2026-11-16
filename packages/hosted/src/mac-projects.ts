/**
 * Personal projects from a folder of this Mac with no remote (cloud parity part 5), as the server keeps them: made,
 * their history sent once as the project's origin, listed, and removed; and a thread's newest work save, read, made
 * current and downloaded, for the folder its project came from. A server from before them answers 404 or names no
 * `macProjects` capability: they are unavailable there.
 */
import { z } from "zod";
import { RawBody } from "./raw-body.js";
import { Refused, type Session } from "./session.js";
import { PARITY_ROUTES } from "./wire-parity.js";
import type { Route } from "./wire.js";

const macProject = z.object({ id: z.string(), name: z.string(), origin: z.literal("mac"), defaultBranch: z.string(), sent: z.boolean() });
export type WireMacProject = z.infer<typeof macProject>;
const listed = z.array(z.union([macProject, z.object({ id: z.string() }).passthrough()]));
const workSave = z.object({
  save: z.object({ branch: z.string().nullable(), head: z.string(), base: z.string(), bundle: z.boolean(), uncommitted: z.boolean(), savedAt: z.string() }).nullable(),
  current: z.boolean(),
  working: z.boolean(),
  ends: z.array(z.string()),
});
export type WireWorkSave = z.infer<typeof workSave>;

const thread = (id: string) => `/hosted/threads/${encodeURIComponent(id)}/work-save`;

export const MAC_PROJECT_ROUTES = {
  list: { method: "GET", path: "/projects?origins=github,mac", reply: listed } satisfies Route<z.infer<typeof listed>>,
  create: { method: "POST", path: "/projects/mac", reply: macProject } satisfies Route<WireMacProject>,
  origin: (projectId: string, head: string): Route<WireMacProject> => ({
    method: "PUT",
    path: `/projects/${encodeURIComponent(projectId)}/origin?${new URLSearchParams({ head })}`,
    reply: macProject,
  }),
  remove: (projectId: string): Route<null> => ({ method: "DELETE", path: `/projects/${encodeURIComponent(projectId)}`, reply: null }),
  workSave: (threadId: string): Route<WireWorkSave> => ({ method: "GET", path: thread(threadId), reply: workSave }),
  ask: (threadId: string): Route<{ asked: boolean }> => ({ method: "POST", path: `${thread(threadId)}/ask`, reply: z.object({ asked: z.boolean() }) }),
};

export class CloudMacProjects {
  constructor(private readonly deps: { session: Session }) {}

  /** Whether the person's Personal space's server keeps mac projects. */
  async served(personal: string): Promise<boolean> {
    try {
      return (await this.deps.session.in(personal).request(PARITY_ROUTES.capabilities)).features.macProjects?.available === true;
    } catch (error) {
      if (error instanceof Refused && error.status === 404) return false;
      throw error;
    }
  }

  async list(personal: string): Promise<WireMacProject[]> {
    const all = await this.deps.session.in(personal).request(MAC_PROJECT_ROUTES.list);
    return all.flatMap((one) => {
      const parsed = macProject.safeParse(one);
      return parsed.success ? [parsed.data] : [];
    });
  }

  create(personal: string, input: { name: string; branch: string }): Promise<WireMacProject> {
    return this.deps.session.in(personal).request(MAC_PROJECT_ROUTES.create, input);
  }

  /** Sends the folder's history as the project's origin, its bytes counted to `sent` as they go. */
  sendOrigin(personal: string, projectId: string, head: string, chunks: () => AsyncIterable<Uint8Array>): Promise<WireMacProject> {
    return this.deps.session.in(personal).request(MAC_PROJECT_ROUTES.origin(projectId, head), new RawBody(chunks));
  }

  async remove(personal: string, projectId: string): Promise<void> {
    await this.deps.session.in(personal).request(MAC_PROJECT_ROUTES.remove(projectId));
  }

  workSave(space: string, threadId: string): Promise<WireWorkSave> {
    return this.deps.session.in(space).request(MAC_PROJECT_ROUTES.workSave(threadId));
  }

  ask(space: string, threadId: string): Promise<{ asked: boolean }> {
    return this.deps.session.in(space).request(MAC_PROJECT_ROUTES.ask(threadId));
  }

  /** The newest work save's bundle, for the caller to read under its own signal and bounds. */
  bundle(space: string, threadId: string, signal: AbortSignal): Promise<Response> {
    return this.deps.session.stream(space, `${thread(threadId)}/bundle`, signal);
  }
}
