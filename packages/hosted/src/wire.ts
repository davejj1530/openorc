/**
 * The server's routes and the shapes it answers, parsed where they enter. Nothing outside the package sees a type from
 * this file: translate.ts turns each into the app's own.
 */
import { AgentKind, BackgroundCommand, PermissionPreset, PrState, RunMode } from "@openorc/protocol";
import { z } from "zod";

/** A route with the shape of its answer, so a reply is always parsed where it enters. Null: the body is not read. */
export interface Route<T> {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  reply: z.ZodType<T> | null;
}

const iso = z.iso.datetime();
const hours = z.object({ grantedSeconds: z.number().int(), usedSeconds: z.number().int(), leftSeconds: z.number().int() });
const paidBy = z.discriminatedUnion("kind", [z.object({ kind: z.literal("self") }), z.object({ kind: z.literal("organization"), organizationId: z.string() })]);

export const wireBilling = z.object({
  pro: z.union([
    z.object({ status: z.literal("free") }),
    z.object({ status: z.literal("pro"), standing: z.literal("live"), renewsAt: iso, paidBy }),
    z.object({ status: z.literal("pro"), standing: z.enum(["ending", "grace"]), until: iso, paidBy }),
  ]),
  period: z.object({ startsAt: iso, endsAt: iso }).nullable(),
  monthly: hours.nullable(),
  packs: z.array(hours.extend({ boughtAt: iso, expiresAt: iso })),
  leftSeconds: z.number().int(),
});
export type WireBilling = z.infer<typeof wireBilling>;

/**
 * Who the session is for. Better Auth answers null for a session it no longer holds. The server never takes a picture
 * from an app, so `image` is whatever it was given elsewhere.
 */
export const wirePerson = z.object({ user: z.object({ name: z.string(), email: z.string(), image: z.string().nullish() }) }).nullable();
export type WirePerson = z.infer<typeof wirePerson>;

/** The person's own settings for their cloud threads: the sandbox service they chose, the ones served, and the default. */
export const wireHostedSettings = z.object({
  service: z.string().nullable(),
  served: z.array(z.object({ service: z.string(), name: z.string() })),
  defaultService: z.string(),
});
export type WireHostedSettings = z.infer<typeof wireHostedSettings>;

/** One of the person's agent sign-ins, never its secret. `checkedAt` changes whenever the sign-in is set again. */
export const wireSignIn = z.object({ agent: z.string(), provider: z.string(), label: z.string(), checkedAt: iso.nullable() });
export type WireSignIn = z.infer<typeof wireSignIn>;

const seq = z.number().int().nonnegative();

/** A message to a thread, as its `waiting` lists it: not taken yet, or refused since. `afterTurn`: sent to wait for the running turn to end. */
export const wireMessage = z.object({
  id: z.string(),
  authorId: z.string().nullable(),
  text: z.string(),
  state: z.string(),
  refusal: z.string().nullable(),
  afterTurn: z.boolean().default(false),
  createdAt: iso,
});
export type WireMessage = z.infer<typeof wireMessage>;

/**
 * A hosted thread as the person's list shows it. Words the server may add to (`status`, an ask's `kind`) are read as
 * strings, so a newer server's value reads as the nearest known one instead of failing the whole list.
 */
export const wireThread = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  parentId: z.string().nullable(),
  title: z.string(),
  baseBranch: z.string(),
  branch: z.string(),
  settings: z.object({ agent: AgentKind, model: z.string().nullable(), effort: z.string().nullable(), mode: RunMode, permissionMode: PermissionPreset }),
  status: z.string(),
  head: seq,
  /** The live turn; null between turns, also while an ask waits after its turn ended. */
  turn: z.object({ id: z.string() }).nullable().default(null),
  /** The reader's own view: how far they read, and when they pinned, put away or snoozed the thread. */
  seenSeq: seq,
  pinnedAt: iso.nullable().default(null),
  archivedAt: iso.nullable().default(null),
  snoozedUntil: iso.nullable().default(null),
  lastAgentSeq: seq,
  backgroundCommands: z.array(BackgroundCommand).default([]),
  waiting: z.array(wireMessage).default([]),
  /** `kind` is read as a word, so a kind a newer server adds reads as a tool's. */
  ask: z.object({ id: z.string(), kind: z.string().default("tool"), detail: z.string() }).nullable(),
  pullRequest: z.object({ url: z.string(), state: PrState }).nullable().default(null),
  createdBy: z.string().nullable(),
  createdAt: iso,
  lastActivityAt: iso,
});
export type WireThread = z.infer<typeof wireThread>;

export const wireThreadList = z.object({ threads: z.array(wireThread) });

/** One thread, with the seq of each `turn.completed` in its log: where its turns end, as the app counts them. */
export const wireThreadDetail = wireThread.extend({ turnEnds: z.array(z.number().int().positive()) });
export type WireThreadDetail = z.infer<typeof wireThreadDetail>;

/** One line of a thread's log. `event` is checked against the app's own events where it is translated. */
export const wireEvent = z.object({ seq: z.number().int().positive(), event: z.record(z.string(), z.unknown()) });
export type WireEvent = z.infer<typeof wireEvent>;

export const wireEvents = z.object({ events: z.array(wireEvent), head: seq, fromTurn: seq.optional() });
export type WireEvents = z.infer<typeof wireEvents>;

/** A project of the person's space: a GitHub repository. */
export const wireProject = z.object({ id: z.string(), name: z.string(), fullName: z.string() });
export type WireProject = z.infer<typeof wireProject>;

/** What a send answers: the message as it now stands, or a refusal to start a turn, with nothing stored. */
export const wireSent = z.discriminatedUnion("sent", [z.object({ sent: z.literal(true), message: wireMessage }), z.object({ sent: z.literal(false), refusal: z.string() })]);

/** What an answer to an ask answers: taken, or refused because it would start a turn the person cannot start. */
export const wireAnswered = z.discriminatedUnion("answered", [z.object({ answered: z.literal(true) }), z.object({ answered: z.literal(false), refusal: z.string() })]);

/** Socket messages, server to app: a topic of the person's changed, a stored batch of a thread's log, a row's facts moved. */
export const wireTopics = z.object({ topics: z.array(z.string()) });
export const wireFrame = z.object({ threadId: z.string(), events: z.array(wireEvent).min(1) });
export const wireChange = z.object({ threadId: z.string(), head: seq });
export const wireWatched = z.object({ ok: z.boolean(), head: seq });

/** The socket's event names. */
export const SOCKET = { changed: "changed", watch: "hosted:watch", unwatch: "hosted:unwatch", events: "hosted:events", threadChanged: "hosted:changed" } as const;

/** The words a refusal carries, from either Better Auth (`{ code, message }`) or the server's own routes (`{ message }`). */
export const wireRefusal = z.object({ message: z.string().min(1) });

/** Signing in answers the session's signed token in this header. The body's `token` is the bare session id, which no route takes. */
export const TOKEN_HEADER = "set-auth-token";

const route = <T = null>(method: Route<T>["method"], path: string, reply: z.ZodType<T> | null): Route<T> => ({ method, path, reply });

/** Every route the app calls, in one list. The stand-in server in testing/ serves exactly these. */
export const ROUTES = {
  sendCode: route("POST", "/api/auth/email-otp/send-verification-otp", null),
  signIn: route("POST", "/api/auth/sign-in/email-otp", null),
  signOut: route("POST", "/api/auth/sign-out", null),
  billing: route("GET", "/billing", wireBilling),
  person: route("GET", "/api/auth/get-session", wirePerson),
  hostedSettings: route("GET", "/settings/hosted", wireHostedSettings),
  setHostedSettings: route("PATCH", "/settings/hosted", wireHostedSettings),
  signIns: route("GET", "/agent-sign-ins", z.array(wireSignIn)),
  projects: route("GET", "/projects", z.array(wireProject)),
  threads: route("GET", "/hosted/threads", wireThreadList),
  thread: (id: string) => route("GET", `/hosted/threads/${encodeURIComponent(id)}`, wireThreadDetail),
  /** After a seq, before one, or from a turn, at most `limit` events. */
  events: (id: string, from: { after: number } | { before: number } | { fromTurn: number }, limit: number) =>
    route("GET", `/hosted/threads/${encodeURIComponent(id)}/events?${new URLSearchParams({ ...stringsOf(from), limit: String(limit) })}`, wireEvents),
  /** One message to the thread. Sending the same id again is the same message. */
  send: (id: string) => route("POST", `/hosted/threads/${encodeURIComponent(id)}/messages`, wireSent),
  /** Cancels a message not taken yet, or dismisses a refused one (assumed of the server: not served today). */
  unsend: (id: string, messageId: string) => route("DELETE", `/hosted/threads/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}`, null),
  /** Renames the thread, or changes what its next turns run with, for everyone in it. Answers the row. */
  update: (id: string) => route("PATCH", `/hosted/threads/${encodeURIComponent(id)}`, wireThread),
  /** The reader's own view of the thread: how far they read, pinned, put away, snoozed. Answers the row. */
  mine: (id: string) => route("PUT", `/hosted/threads/${encodeURIComponent(id)}/mine`, wireThread),
  remove: (id: string) => route("DELETE", `/hosted/threads/${encodeURIComponent(id)}`, null),
  stop: (id: string) => route("POST", `/hosted/threads/${encodeURIComponent(id)}/stop`, null),
  /** The person is about to write: the thread's machine wakes and its agent starts waiting. Answered with nothing. */
  ready: (id: string) => route("POST", `/hosted/threads/${encodeURIComponent(id)}/ready`, null),
  answer: (askId: string) => route("POST", `/hosted/asks/${encodeURIComponent(askId)}/answer`, wireAnswered),
  stopCommand: (id: string, commandId: string) => route("POST", `/hosted/threads/${encodeURIComponent(id)}/commands/${encodeURIComponent(commandId)}/stop`, null),
} as const;

function stringsOf(from: Record<string, number>): Record<string, string> {
  return Object.fromEntries(Object.entries(from).map(([key, value]) => [key, String(value)]));
}
