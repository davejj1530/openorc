import { z } from "zod";
import type { Route } from "./wire.js";

const person = z.object({ id: z.string(), name: z.string(), image: z.string().nullable() });
export const wireTerminal = z.object({
  id: z.string(),
  threadId: z.string(),
  openedBy: person,
  state: z.enum(["opening", "open", "ended"]),
  cols: z.number().int(),
  rows: z.number().int(),
  typed: z.number().int().nonnegative(),
  ended: z.object({ reason: z.string(), message: z.string(), exitCode: z.number().int().nullable(), by: person.nullable() }).nullable(),
});
const wireTerminals = z.object({ terminals: z.array(wireTerminal), canOpen: z.boolean(), reason: z.string().nullable(), viewer: z.string() });
const wireOutput = z.object({ from: z.number().int().nonnegative(), end: z.number().int().nonnegative(), data: z.string(), terminal: wireTerminal });

const of = (threadId: string) => `/hosted/threads/${encodeURIComponent(threadId)}/terminals`;
const one = (threadId: string, terminalId: string) => `${of(threadId)}/${encodeURIComponent(terminalId)}`;

/** A cloud thread's terminals: listed, opened, read from an offset, typed in, sized and ended. */
export const TERMINAL_ROUTES = {
  list: (threadId: string): Route<z.infer<typeof wireTerminals>> => ({ method: "GET", path: of(threadId), reply: wireTerminals }),
  open: (threadId: string): Route<z.infer<typeof wireTerminal>> => ({ method: "POST", path: of(threadId), reply: wireTerminal }),
  output: (threadId: string, terminalId: string, from: number): Route<z.infer<typeof wireOutput>> => ({ method: "GET", path: `${one(threadId, terminalId)}/output?from=${from}`, reply: wireOutput }),
  input: (threadId: string, terminalId: string): Route<{ at: number }> => ({ method: "POST", path: `${one(threadId, terminalId)}/input`, reply: z.object({ at: z.number().int().nonnegative() }) }),
  size: (threadId: string, terminalId: string): Route<z.infer<typeof wireTerminal>> => ({ method: "POST", path: `${one(threadId, terminalId)}/size`, reply: wireTerminal }),
  end: (threadId: string, terminalId: string): Route<z.infer<typeof wireTerminal>> => ({ method: "DELETE", path: one(threadId, terminalId), reply: wireTerminal }),
};

/** The server's socket events for a watched terminal. */
export const TERMINAL_SOCKET = { watch: "hosted:terminal:watch", unwatch: "hosted:terminal:unwatch", output: "hosted:terminal:output", changed: "hosted:terminal:changed" } as const;
export const wireTerminalFrame = z.object({ terminalId: z.string(), at: z.number().int().nonnegative(), data: z.string() });
export const wireTerminalWatched = z.object({ ok: z.boolean() });
