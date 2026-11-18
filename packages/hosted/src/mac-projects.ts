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
  /** A save someone asked for is still to be made; a server from before it names none. */
  asked: z.boolean().optional(),
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
  withdraw: (threadId: string): Route<null> => ({ method: "DELETE", path: `${thread(threadId)}/ask`, reply: null }),
};

/** How a wait for a save reaches the server, and its clock. */
export interface SaveAsking {
  workSave(): Promise<WireWorkSave>;
  ask(): Promise<{ asked: boolean }>;
  withdraw(): Promise<void>;
  now(): number;
  pause(ms: number): Promise<void>;
}

/** The answer of a server asked for a save while a turn runs: ask again once it has ended. */
const turnRunning = (error: unknown) => error instanceof Refused && error.status === 409;

/**
 * Has the thread leave its machine with a save of what its folder holds, and answers the newest save once that one is
 * made. A turn running there goes on: the ask waits for it to end, and the server's `asked` says when the save is made
 * (a message arriving as the thread leaves keeps the folder in use, so `current` alone may never come). A server from
 * before `asked` is waited on until the save is current. After `ms` it gives up, and takes back an ask nothing was
 * done about yet, so the thread doesn't leave later for a wait that ended.
 */
export async function leaveWithSave(calls: SaveAsking, ms: number): Promise<WireWorkSave> {
  const until = calls.now() + ms;
  const pending = (work: WireWorkSave) => work.asked ?? !work.current;
  let work = await calls.workSave();
  if (work.current && !work.asked) return work;
  let asked = work.asked === true;
  for (;;) {
    if (asked) {
      if (!pending(work)) return work;
    } else if (!work.working) {
      const answer = await calls.ask().catch((error: unknown) => {
        if (turnRunning(error)) return null;
        throw error;
      });
      if (answer && !answer.asked) return calls.workSave();
      asked = answer !== null;
    }
    if (calls.now() > until) {
      if (asked) await calls.withdraw().catch(() => undefined);
      throw new SaveNotMade(work.working);
    }
    await calls.pause(1_000);
    work = await calls.workSave();
  }
}

/** A wait for a save that gave up: the turn on the machine still ran (`working`), or the save didn't come. */
export class SaveNotMade extends Error {
  constructor(readonly working: boolean) {
    super(working ? "The thread's turn is still running. Try again once it ends." : "The thread didn't save its work in time. Try again.");
    this.name = "SaveNotMade";
  }
}

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

  /** The thread's newest save once it left its machine with one, a turn there waited for (leaveWithSave). */
  leave(space: string, threadId: string, ms: number): Promise<WireWorkSave> {
    const place = this.deps.session.in(space);
    return leaveWithSave(
      {
        workSave: () => place.request(MAC_PROJECT_ROUTES.workSave(threadId)),
        ask: () => place.request(MAC_PROJECT_ROUTES.ask(threadId)),
        withdraw: async () => void (await place.request(MAC_PROJECT_ROUTES.withdraw(threadId))),
        now: Date.now,
        pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
      ms,
    );
  }

  /** The newest work save's bundle, for the caller to read under its own signal and bounds. */
  bundle(space: string, threadId: string, signal: AbortSignal): Promise<Response> {
    return this.deps.session.stream(space, `${thread(threadId)}/bundle`, signal);
  }
}
