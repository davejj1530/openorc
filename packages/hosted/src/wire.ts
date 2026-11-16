/**
 * The server's routes and the shapes it answers, parsed where they enter. Nothing outside the package sees a type from
 * this file: translate.ts turns each into the app's own.
 */
import { AgentKind, AllowanceSource, BackgroundCommand, PermissionPreset, PrState, RunMode, TeamChatFile } from "@openorc/protocol";
import { z } from "zod";
import { wireGithubChoose, wireGithubStatus } from "./wire-github.js";
import { SPACE_ROUTES } from "./wire-spaces.js";
import { wireOrganizationAccess } from "./organization-access-wire.js";
import { wireCollaboration } from "./wire-collaboration.js";

/** A route with the shape of its answer, so a reply is always parsed where it enters. Null: the body is not read. */
export interface Route<T> {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  reply: z.ZodType<T> | null;
  /** Optional validated refusal for routes with a structured conflict. */
  refusal?: (status: number, body: unknown) => Error | undefined;
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
  organizationAccess: wireOrganizationAccess.optional(),
  allowanceSource: AllowanceSource.nullable().optional(),
});
export type WireBilling = z.infer<typeof wireBilling>;

const wirePrice = z.object({ amount: z.number().int().nonnegative(), currency: z.string().min(1) }).nullable();

/** What Pro and an hours pack cost, as the server reads them from Polar's products. */
export const wireOffers = z.object({
  monthlySeconds: z.number().int().positive().nullable().default(null),
  pro: z.array(z.object({ plan: z.string(), price: wirePrice })),
  hours: z.object({ seconds: z.number().int().positive(), months: z.number().int().positive(), price: wirePrice }),
});
export type WireOffers = z.infer<typeof wireOffers>;

/** A page of Polar's the server made for the person: a checkout, or their billing portal. Only the browser is given it. */
export const wireBillingLink = z.object({ url: z.url() });

/**
 * Who the session is for. Better Auth answers null for a session it no longer holds. The server never takes a picture
 * from an app, so `image` is whatever it was given elsewhere.
 */
export const wirePerson = z.object({ user: z.object({ id: z.string(), name: z.string(), email: z.string(), image: z.string().nullish() }) }).nullable();
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

/** A Codex device code the server started with OpenAI: the person enters `userCode` on `verificationUrl`. */
export const wireDeviceStart = z.object({ id: z.string(), userCode: z.string(), verificationUrl: z.url(), intervalSeconds: z.number().int().positive(), expiresAt: iso });
export const wireDeviceFinish = z.discriminatedUnion("status", [z.object({ status: z.literal("pending") }), z.object({ status: z.literal("connected") }), z.object({ status: z.literal("expired") })]);

const seq = z.number().int().nonnegative();

/** A message to a thread, as its `waiting` lists it: not taken yet, or refused since. `afterTurn`: sent to wait for the running turn to end. */
export const wireMessage = z.object({
  id: z.string(),
  authorId: z.string().nullable(),
  text: z.string(),
  files: z.array(TeamChatFile).optional(),
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
  /** Who started the thread, as a teammate's list names them; null once their account is gone. */
  startedBy: z.object({ id: z.string(), name: z.string(), image: z.string().nullish() }).nullable().default(null),
  /** Working together in the thread, as this reader sees it; absent from a server that predates it, or unreadable. */
  collaboration: wireCollaboration.optional().catch(undefined),
  createdAt: iso,
  lastActivityAt: iso,
});
export type WireThread = z.infer<typeof wireThread>;

export const wireThreadList = z.object({ threads: z.array(wireThread) });

/** One thread, with the seq of each `turn.completed` in its log: where its turns end, as the app counts them. */
export const wireThreadDetail = wireThread.extend({ turnEnds: z.array(z.number().int().positive()) });
export type WireThreadDetail = z.infer<typeof wireThreadDetail>;

/**
 * One line of a thread's log. `event` is checked against the app's own events where it is translated. `turnId`: the turn
 * it belongs to; `by`: the person who caused it, null for the agent's own.
 */
export const wireEvent = z.object({ seq: z.number().int().positive(), turnId: z.string().nullable().optional(), by: z.string().nullable().optional(), event: z.record(z.string(), z.unknown()) });
export type WireEvent = z.infer<typeof wireEvent>;

export const wireEvents = z.object({ events: z.array(wireEvent), head: seq, fromTurn: seq.optional() });
export type WireEvents = z.infer<typeof wireEvents>;

/** A project of one of the person's spaces: a GitHub repository. */
export const wireProject = z.object({ id: z.string(), name: z.string(), fullName: z.string(), connected: z.boolean().default(true) });

/**
 * A project as a reader that knows projects from a folder of a Mac lists them: a GitHub repository, or a Personal
 * project from a folder of its creator's Mac, which has no repository (`fullName` null). A server from before them
 * lists repositories alone.
 */
export const wireAnyProject = z.union([
  wireProject,
  z.object({ id: z.string(), name: z.string(), origin: z.literal("mac") }).transform(({ id, name }) => ({ id, name, fullName: null, connected: true })),
]);

/**
 * One of the person's spaces: their personal one, whose `personalOf` is their own user id, or a team they are in. Read
 * as Better Auth lists a person's organizations; the app never says the word.
 */
export const wireSpace = z.object({ id: z.string(), personalOf: z.string().nullish() });
export type WireSpace = z.infer<typeof wireSpace>;
export type WireProject = z.infer<typeof wireProject>;

/** What a send answers: the message as it now stands, or a refusal to start a turn, with nothing stored. */
export const wireSent = z.discriminatedUnion("sent", [z.object({ sent: z.literal(true), message: wireMessage }), z.object({ sent: z.literal(false), refusal: z.string() })]);

/** A new thread with what became of its first message; a first message refused makes no thread. */
export const wireCreated = z.object({ thread: wireThread.nullable(), first: wireSent.nullable() });

/** The GitHub accounts OpenOrc's GitHub app is installed on for the space, and whether the server has the app at all. */
export const wireGithub = wireGithubStatus;
/** The GitHub account the person linked. */
export const wireGithubLink = z.object({ configured: z.boolean(), account: z.object({ login: z.string() }).nullable() });
/** A repository an installation lets OpenOrc read, which can be made a project. */
export const wireGithubRepository = z.object({ installationId: z.string(), repoId: z.number(), fullName: z.string() });
export type WireGithubRepository = z.infer<typeof wireGithubRepository>;
/** Starting a GitHub step for an app waiting on a loopback port: GitHub's page to go through, or how it went with none. */
export const wireGithubStart = z.discriminatedUnion("kind", [
  wireGithubChoose,
  z.object({ kind: z.literal("github"), step: z.enum(["link", "install"]), url: z.url(), expiresInMs: z.number() }),
  z.object({ kind: z.literal("settled"), outcome: z.string() }),
]);
export type WireGithubStart = z.infer<typeof wireGithubStart>;
/** How a GitHub step the app finished went, as a word the server may add to. */
export const wireGithubOutcome = z.object({ outcome: z.string() });

/** What an answer to an ask answers: taken, or refused because it would start a turn the person cannot start. */
export const wireAnswered = z.discriminatedUnion("answered", [z.object({ answered: z.literal(true) }), z.object({ answered: z.literal(false), refusal: z.string() })]);

/** Socket messages, server to app: a topic of the person's changed, a stored batch of a thread's log, a row's facts moved. */
export const wireTopics = z.object({ organizationId: z.string().optional(), topics: z.array(z.string()) });
export const wireFrame = z.object({ threadId: z.string(), events: z.array(wireEvent).min(1) });
export const wireChange = z.object({ threadId: z.string(), head: seq });
export const wireWatched = z.object({ ok: z.boolean(), head: seq });

/** The socket's event names. */
export const SOCKET = { changed: "changed", watch: "hosted:watch", unwatch: "hosted:unwatch", events: "hosted:events", threadChanged: "hosted:changed" } as const;

/** Runtime refusals use one sentence; decorated body validators use an ordered list of sentences. */
export const wireRefusal = z.object({
  message: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).transform((message) => (typeof message === "string" ? message : message[0]!)),
  code: z.string().optional(),
});

/** A sign-in through the browser the server started for an app waiting on a loopback port: the page the browser opens for it. */
export const wireAppSignInStart = z.object({ request: z.string().min(1), url: z.url(), resultUrl: z.url(), expiresInMs: z.number() });
/** The session's bearer token, given once, for the request the browser approved. */
export const wireAppSignInFinish = z.object({ token: z.string().min(1) });

const route = <T = null>(method: Route<T>["method"], path: string, reply: z.ZodType<T> | null): Route<T> => ({ method, path, reply });

/** Every route the app calls, in one list. The stand-in server in testing/ serves exactly these. */
export const ROUTES = {
  ...SPACE_ROUTES,
  /** Starts a sign-in through the browser for an app waiting on a loopback port, with the challenge of a verifier only the app holds. */
  appSignInStart: route("POST", "/app-sign-in/start", wireAppSignInStart),
  /** Trades the code the browser brought back, and the verifier, for the session's token; 410 in words once it is spent or ran out. */
  appSignInFinish: route("POST", "/app-sign-in/finish", wireAppSignInFinish),
  /** Gives up a sign-in, proving ownership with the verifier; a missing request is already canceled. */
  appSignInCancel: route("POST", "/app-sign-in/cancel", null),
  signOut: route("POST", "/api/auth/sign-out", null),
  billing: route("GET", "/billing", wireBilling),
  offers: route("GET", "/billing/offers", wireOffers),
  /** A checkout for the person's own Pro, by the period they pay for; 409 in words when they already pay for it. */
  checkoutPro: route("POST", "/billing/checkout/pro", wireBillingLink),
  /** A checkout for an hours pack; 409 in words for a person who is not Pro. */
  checkoutHours: route("POST", "/billing/checkout/hours", wireBillingLink),
  /** Polar's portal, where the person changes or cancels what they pay for; 404 in words when they never bought anything. */
  portal: route("POST", "/billing/portal", wireBillingLink),
  person: route("GET", "/api/auth/get-session", wirePerson),
  updateProfile: route("PATCH", "/account/profile", z.object({ id: z.string(), name: z.string(), email: z.string(), image: z.string().nullable() })),
  hostedSettings: route("GET", "/settings/hosted", wireHostedSettings),
  setHostedSettings: route("PATCH", "/settings/hosted", wireHostedSettings),
  signIns: route("GET", "/agent-sign-ins", z.array(wireSignIn)),
  /** Keeps a sign-in for an agent, once its vendor takes it; a refusal is 400 in the vendor's words. */
  setSignIn: (agent: "claude" | "codex" | "opencode", provider?: string) =>
    route("PUT", `/agent-sign-ins/${agent === "opencode" ? `opencode/${encodeURIComponent(provider ?? "")}` : agent}`, wireSignIn),
  removeSignIn: (agent: "claude" | "codex" | "opencode", provider?: string) =>
    route("DELETE", `/agent-sign-ins/${agent === "opencode" ? `opencode/${encodeURIComponent(provider ?? "")}` : agent}`, null),
  startDevice: route("POST", "/agent-sign-ins/codex/device/start", wireDeviceStart),
  finishDevice: route("POST", "/agent-sign-ins/codex/device/finish", wireDeviceFinish),
  spaces: route("GET", "/api/auth/organization/list", z.array(wireSpace)),
  projects: route("GET", "/projects", z.array(wireProject)),
  /** Every project of the space, those from a folder of a Mac with them. */
  allProjects: route("GET", "/projects?origins=github,mac", z.array(wireAnyProject)),
  /** Makes repositories projects of the session's active space, its personal one unless the person chose another. */
  addProjects: route("POST", "/projects", z.array(wireProject)),
  removeProject: (id: string) => route("DELETE", `/projects/${encodeURIComponent(id)}`, null),
  github: route("GET", "/github", wireGithub),
  githubLink: route("GET", "/github/account", wireGithubLink),
  githubRepositories: route("GET", "/github/repositories", z.array(wireGithubRepository)),
  /** Starts installing OpenOrc's GitHub app, or linking the person's account first when the install needs it. */
  githubStart: route("POST", "/github/install/start", wireGithubStart),
  githubLinkFinish: route("POST", "/github/link/finish", wireGithubOutcome),
  githubInstallFinish: route("POST", "/github/install/finish", wireGithubOutcome),
  githubUnlink: route("DELETE", "/github/account", null),
  /** A new thread on a project of the space, with its first message. */
  start: route("POST", "/hosted/threads", wireCreated),
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
