import { z } from "zod";
import { RawBody } from "./raw-body.js";
import { PARITY_ROUTES } from "./wire-parity.js";
import { MAC_ROUTES, type MacWorkUpload } from "./mac-start.js";
import { Refused, type Session } from "./session.js";
import { toAppEvent } from "./translate.js";
import { ROUTES, type Route } from "./wire.js";
import type { AgentEvent } from "@openorc/protocol";

/*
 * The server's half of a thread moving between this Mac and OpenOrc Cloud (core `CloudMoves`): an arrival made under
 * the Mac's id and filled before it is shown, and a thread's saved conversation read for this Mac, then let go of
 * there. Each call is repeatable; core keeps the journal of where a move stands.
 */

const arrived = z.object({ id: z.string() });
const turns = z.object({ turns: z.number().int().nonnegative() });
const bytes = z.object({ bytes: z.number().int().nonnegative() });
const thread = (id: string) => `/hosted/threads/${encodeURIComponent(id)}`;
/** How many events one page of a thread's log reads. */
const EVENTS_PAGE = 1000;

/** The thread's settings as the arrival takes them, the same a new cloud thread is made with. */
export type ArrivalSettings = { agent: string; model: string | null; effort: string | null; mode: string; permissionMode: string };

/** One line of an arrival's history (the server's `hostedArrivalLine`). */
export type ArrivalLine =
  | {
      /** A thread started under the moving thread, by the person or its agent, written before its turns and children. */
      kind: "subthread";
      id: string;
      /** The moving thread, or a subthread written earlier. */
      parentId: string;
      title: string;
      settings: ArrivalSettings;
      createdAt: string;
      startedByAgent: boolean;
      /** Put away by the person moving it; it arrives put away for them alone. */
      archivedAt: string | null;
    }
  | {
      kind: "child";
      id: string;
      /** The conversation whose agent started it: the moving thread when left out, else one of its subthreads. */
      thread?: string;
      title: string;
      settings: ArrivalSettings;
      nativeId: string;
      parentSessionId: string;
      agentType: string | null;
      toolCallId: string | null;
      prompt: string | null;
      status: "completed" | "failed" | "stopped";
      result: string | null;
      error: string | null;
      parentTurnId: string | null;
      startedAt: string;
      endedAt: string | null;
    }
  | {
      kind: "turn";
      thread: string;
      id: string;
      settings: ArrivalSettings;
      startedAt: string;
      endedAt: string;
      outcome: "success" | "error" | "cancelled" | "interrupted";
      message: { id: string; text: string } | null;
      events: Record<string, unknown>[];
    };

export const MOVE_ROUTES = {
  arrive: { method: "POST", path: "/hosted/arrivals", reply: arrived } satisfies Route<z.infer<typeof arrived>>,
  history: (id: string): Route<z.infer<typeof turns>> => ({ method: "PUT", path: `${thread(id)}/arrival/history`, reply: turns }),
  session: (id: string, query: { agent: string; sessionId: string; cliVersion: string; thread?: string }): Route<z.infer<typeof bytes>> => ({
    method: "PUT",
    path: `${thread(id)}/arrival/session?${new URLSearchParams(query)}`,
    reply: bytes,
  }),
  done: (id: string): Route<z.infer<typeof arrived>> => ({ method: "POST", path: `${thread(id)}/arrival/done`, reply: arrived }),
  undo: (id: string): Route<null> => ({ method: "DELETE", path: `${thread(id)}/arrival`, reply: null }),
  movedAway: (id: string): Route<null> => ({ method: "POST", path: `${thread(id)}/moved-away`, reply: null }),
};

export class CloudMoves {
  constructor(private readonly deps: { session: Session }) {}

  /** Whether the space's server moves a thread with the threads started under it, both ways. */
  async movesFamilies(space: string): Promise<boolean> {
    try {
      return (await this.deps.session.in(space).request(PARITY_ROUTES.capabilities)).features.subthreadMoves?.available === true;
    } catch (error) {
      // A server from before capabilities moves no families.
      if (error instanceof Refused && error.status === 404) return false;
      throw error;
    }
  }

  /** Makes the thread under its Mac id in `space`, hidden until done; the same arrival again answers the same. */
  arrive(space: string, input: { id: string; projectId: string; title?: string; settings: ArrivalSettings }): Promise<{ id: string }> {
    return this.deps.session.in(space).request(MOVE_ROUTES.arrive, input);
  }

  /** Sends its history whole, one line at a time as NDJSON; sent again, it replaces what was sent before. */
  history(space: string, id: string, lines: () => AsyncIterable<ArrivalLine>): Promise<{ turns: number }> {
    async function* encoded(): AsyncGenerator<Uint8Array> {
      const encoder = new TextEncoder();
      for await (const line of lines()) yield encoder.encode(`${JSON.stringify(line)}\n`);
    }
    return this.deps.session.in(space).request(MOVE_ROUTES.history(id), new RawBody(encoded));
  }

  /**
   * Sends the agent's conversation as the session slot packed it (agents' `packSession`): the moving thread's, or with
   * `thread` one of its subthreads', sent after the history that names it.
   */
  session(space: string, id: string, query: { agent: string; sessionId: string; cliVersion: string; thread?: string }, packed: Uint8Array): Promise<{ bytes: number }> {
    return this.deps.session.in(space).request(
      MOVE_ROUTES.session(id, query),
      new RawBody(async function* () {
        yield packed;
      }),
    );
  }

  /** Sends the Mac's work for the arrival, as a Mac start sends it: its first save, put back as it first opens. */
  async work(space: string, id: string, upload: Extract<MacWorkUpload, { refusal: null }>): Promise<void> {
    await this.deps.session.in(space).request(MAC_ROUTES.work(id, upload.query), new RawBody(() => upload.chunks()));
  }

  /** Every event of the thread in the app's shapes, oldest first, read a page at a time up to its head. */
  async *events(space: string, id: string): AsyncGenerator<AgentEvent> {
    const on = this.deps.session.in(space);
    let after = 0;
    for (;;) {
      const page = await on.request(ROUTES.events(id, { after }, EVENTS_PAGE));
      for (const event of page.events) yield toAppEvent(id, event);
      const last = page.events.at(-1)?.seq ?? page.head;
      if (!page.events.length || last >= page.head) return;
      after = last;
    }
  }

  /** The arrival is whole: it becomes an ordinary cloud thread. */
  done(space: string, id: string): Promise<{ id: string }> {
    return this.deps.session.in(space).request(MOVE_ROUTES.done(id));
  }

  /** The Mac gave up: the arrival goes with all it holds. */
  async undo(space: string, id: string): Promise<void> {
    await this.deps.session.in(space).request(MOVE_ROUTES.undo(id));
  }

  /**
   * The thread's saved conversation of `agent`, packed, for the caller to read under its own signal and bounds; null
   * for a thread that never saved one, as one that never ran.
   */
  async savedSession(space: string, id: string, agent: string, signal: AbortSignal): Promise<Response | null> {
    try {
      return await this.deps.session.stream(space, `${thread(id)}/work-save/session?${new URLSearchParams({ agent })}`, signal);
    } catch (error) {
      if (error instanceof Refused && error.status === 404) return null;
      throw error;
    }
  }

  /** This Mac took the thread: it goes from the cloud. */
  async movedAway(space: string, id: string): Promise<void> {
    await this.deps.session.in(space).request(MOVE_ROUTES.movedAway(id));
  }
}
