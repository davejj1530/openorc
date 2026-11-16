/**
 * A stand-in for the OpenOrc server, for tests in any package (`@openorc/hosted/testing`). It serves the routes of
 * wire.ts's ROUTES over real HTTP on loopback, and the server's socket over a real WebSocket speaking Socket.IO's own
 * framing, so a test exercises the same fetch, headers, socket client and parsing the app ships.
 *
 * It keeps the real server's rules that the app's behavior depends on:
 *   a code is six digits, works once, only for the address it was sent to, for five minutes and three tries
 *   signing in goes through the browser (stand-in-app-sign-ins.ts) and answers a signed token; a bare session id is no token
 *   every signed-in route answers 401 without `Authorization: Bearer <that token>`
 *   the socket takes the token in its handshake's `auth` and refuses any other with `UNAUTHORIZED`
 *   `revoke()` ends every session, so the next request answers 401, while a socket already open stays open
 *   a request naming a protocol older than the oldest it answers is 426 with words to update OpenOrc
 *   a refused code is said in OpenOrc's words, as the real server's library-refusals.ts says it
 */
import { createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { LiveSocket } from "../index.js";
import { engineSession } from "./stand-in-socket.js";
import { StandInSignIns } from "./stand-in-sign-ins.js";
import { StandInAppSignIns } from "./stand-in-app-sign-ins.js";
import { StandInGithub } from "./stand-in-github.js";
import { StandInSpaces } from "./stand-in-spaces.js";
import { StandInTasks } from "./stand-in-tasks.js";
import { StandInSeats } from "./stand-in-seats.js";
import { StandInUploads } from "./stand-in-uploads.js";
import { StandInSkills } from "./stand-in-skills.js";
import { StandInEnvironment } from "./stand-in-environment.js";
import type { StandInThreadFiles } from "./stand-in-thread-files.js";
import { StandInOrganizations } from "./stand-in-organizations.js";
import { StandInChat, socketAnswers } from "./stand-in-chat.js";
import { billingState, leftSeconds, StandInPayments, type StandInBilling, type StandInOffers } from "./stand-in-billing.js";
import { StandInThreads, type Admit, type StandInPeer, type StandInThreadSeed } from "./stand-in-threads.js";
import type { StandInCollaboration } from "./stand-in-collaboration.js";

export interface StandIn {
  seats: StandInSeats;
  uploads: StandInUploads;
  /** A person's own skills as the server keeps them, behind the `skills` capability of `threadFiles`. */
  skills: StandInSkills;
  /** Projects' own environment variables as the server keeps them, behind the `projectEnvironment` capability of `threadFiles`. */
  environment: StandInEnvironment;
  tasks: StandInTasks;
  chat: StandInChat;
  /** Its origin, for `HostedDeps.server` or `OpenOrcOptions.accountServer`. */
  url: string;
  /**
   * The person signs in on the page the app opened, as `email`: the code mailed to them is typed in and the app's
   * request approved. Answers where the page sends the browser; throws the page's words when it refuses.
   */
  signInPage(url: string, email: string): string;
  /** Sign-ins through the browser: the device names they were started with, and every request running out at once. */
  appSignIns: Pick<StandInAppSignIns, "devices" | "expire">;
  /** What the next GET /billing answers for a person. */
  setBilling(email: string, billing: StandInBilling): void;
  /** Every checkout the person's apps were given, in order. */
  checkouts: StandInPayments["checkouts"];
  /** The person pays on the last checkout opened for them; their apps hear of it on the `billing` topic unless `quiet`. */
  pay(email: string, options?: { quiet?: boolean }): void;
  /** What GET /billing/offers answers next; null answers that billing is not set up. */
  setOffers(offers: StandInOffers | null): void;
  /** The person's name and picture, as the server keeps them; a new person's name is made from their address. */
  setPerson(email: string, person: { name: string; image: string | null }): void;
  /** The sandbox service each person chose in Settings, by address. */
  sandboxes: Map<string, string | null>;
  /** Ends every session, so the next request is refused. */
  revoke(): void;
  /** Stops answering and drops every connection, as an unreachable server does. `up()` brings it back on the same port. */
  down(): Promise<void>;
  up(): Promise<void>;
  /** Every request it took, sockets included, to assert on. Never the token itself. */
  requests: { method: string; path: string; authorized: boolean }[];
  /** A socket held in this process under the same rules as the WebSocket one, for packages without a socket client. */
  connect(url: string, token: string): LiveSocket;
  /** A team of these people, the first its admin. Answers the space's id. */
  addTeam(name: string, members: string[]): string;
  /** A project for a GitHub repository `owner/name`, in the person's personal space or the space named. Answers its id. */
  addProject(email: string, project: { name: string; fullName: string }, space?: string): string;
  /** A thread the person started, in its project's space. Answers its id. */
  addThread(email: string, seed: StandInThreadSeed): string;
  /** Stores events in a thread's log, in its running turn or `turnId`'s, and sends them to its watchers, unless `quiet` (a frame lost on the way). */
  append(threadId: string, events: Record<string, unknown>[], options?: { by?: string; quiet?: boolean; turnId?: string }): void;
  /** Changes what a thread's row says, and tells its reader. */
  set(threadId: string, facts: { status?: "idle" | "working" | "needs_answer"; seenSeq?: number; backgroundCommands?: { id: string; description: string }[] }): void;
  /** The background commands a person asked to stop in a thread, in order. */
  stoppedCommands(threadId: string): string[];
  /** The person's agent sign-ins, as GET /agent-sign-ins lists them; `ended` ones refuse a turn as signed out. */
  setSignIns(email: string, signIns: StandInSignIn[]): void;
  /** The person approves the Codex device code they were shown, on OpenAI's page. */
  approveDevice(email: string): void;
  /** Every sign-in secret the server was handed, in order. */
  signInSecrets: { agent: string; secret: string }[];
  /** The agent asks before it acts, or asks a question, in a thread. Answers the ask's id, its `approvalId`. */
  ask(threadId: string, request: { kind: string; toolName?: string; input: unknown; detail: string }): string;
  /** The thread's running turn ends: an open ask parks, and the first waiting message is taken or refused. */
  endTurn(threadId: string, status?: "success" | "cancelled"): void;
  /** Every ready ask stored, in order. */
  readies: { threadId: string; settings: unknown }[];
  /** Every message body posted, in order. */
  sent: { threadId: string; body: Record<string, unknown> }[];
  /** Every answer to an ask, in order, as the server took it. */
  answered: { askId: string; who: string; body: Record<string, unknown> }[];
  /** Every POST /hosted/threads body, in order, with the space it was made in. */
  started: { space: string; body: Record<string, unknown> }[];
  /** The capabilities the server answers and the files rules they turn on. */
  threadFiles: StandInThreadFiles;
  /** Working together in a thread: whether the server serves it, and whether shared writing is open. */
  threadCollaboration: StandInCollaboration;
  /** GitHub as the server reaches it: what an install grants, and where its pages send the browser back. */
  github: Pick<StandInGithub, "grant" | "returnFor" | "configured">;
  organizations: StandInOrganizations;
  spaces: StandInSpaces;
  close(): Promise<void>;
}

export interface StandInSignIn {
  agent: "claude" | "codex" | "opencode";
  provider?: string;
  label?: string;
  ended?: boolean;
  /** When the vendor last took it; it changes each time the sign-in is set. */
  checkedAt?: string;
}

export type { StandInBilling, StandInOffers };

const NOT_INVITED = "This email doesn't belong to any organization yet.";
/** The real server's words for a refused code, by the code its auth library names. */
const CODE_REFUSALS = {
  INVALID_OTP: "That code isn't right. Check the email and type it again.",
  OTP_EXPIRED: "That code has expired. Send yourself a new one.",
  TOO_MANY_ATTEMPTS: "That code was tried too many times. Send yourself a new one.",
} as const;
const APP_TOO_OLD = "This version of OpenOrc is too old for OpenOrc Cloud. Update OpenOrc to keep using it.";
const OLDEST_APP_PROTOCOL = 1;
const CODE_MS = 5 * 60_000;
const CODE_TRIES = 3;
const SOCKET_PATH = "/socket.io/";
/** What the real server calls each sandbox service it can run threads on. */
const SERVICE_NAMES: Record<string, string> = { local: "this machine", vercel: "Vercel", agent37: "Agent37" };

/** An in-process socket: its state, the server's messages to it, and whether it waits for the server to come back. */
interface Peer extends StandInPeer {
  token: string;
  emit(state: "up" | "down" | "refused"): void;
  waiting: boolean;
}

type Reply = { status: number; body: unknown };

export interface StandInOptions {
  signup?: "open" | "invite";
  invited?: string[];
  /** The sandbox services it runs threads on, its default first. The real server's default alone when unset. */
  services?: string[];
  now?: () => number;
}

/** "sam.lee@acme.com" becomes "Sam Lee", as the real server names a person who signed up with a code. */
function nameFromEmail(email: string): string {
  return email
    .split("@")[0]!
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

/** The server's sign-in and billing rules, held in memory: codes by address, sessions by id, billing by address. */
function accounts(options: StandInOptions) {
  const secret = randomBytes(32);
  const codes = new Map<string, { code: string; at: number; tries: number }>();
  const sessions = new Map<string, string>();
  const billing = new Map<string, StandInBilling>();
  const people = new Map<string, { name: string; image: string | null }>();
  const sandboxes = new Map<string, string | null>();
  const signIns = new Map<string, StandInSignIn[]>();
  const services = options.services ?? ["local"];
  const admit = turnRule(billing, signIns);
  const hostedSettings = (email: string) => ({
    service: sandboxes.get(email) ?? null,
    served: services.map((service) => ({ service, name: SERVICE_NAMES[service] ?? service })),
    defaultService: services[0]!,
  });
  const sign = (id: string) => createHmac("sha256", secret).update(id).digest("base64url");
  /** The address a signed token's session is for, or null for a bare id, a forged one or an ended session. */
  const holder = (token: string | null | undefined): string | null => {
    const [id, signature] = (token ?? "").split(".");
    if (!id || !signature || signature !== sign(id)) return null;
    return sessions.get(id) ?? null;
  };
  /** Checks the code last mailed to the person, spending it when it is right: null then, else the refusal. */
  const checkCode = (email: string, otp: string): Reply | null => {
    const sent = codes.get(email);
    if (!sent) return codeRefused(400, "INVALID_OTP");
    if (Date.now() - sent.at > CODE_MS) {
      codes.delete(email);
      return codeRefused(400, "OTP_EXPIRED");
    }
    if (sent.tries >= CODE_TRIES) {
      codes.delete(email);
      return codeRefused(403, "TOO_MANY_ATTEMPTS");
    }
    if (otp !== sent.code) {
      sent.tries++;
      return codeRefused(400, "INVALID_OTP");
    }
    codes.delete(email);
    return null;
  };
  /** A new session for the person, as its signed token. */
  const session = (email: string): string => {
    const id = randomUUID().replaceAll("-", "");
    sessions.set(id, email);
    return `${id}.${sign(id)}`;
  };
  /** Each route by method and path, given the request's body and its bearer token. */
  const routes: Record<string, (body: Record<string, unknown>, token: string | null) => Reply> = {
    "POST /api/auth/email-otp/send-verification-otp": (body) => {
      const email = String(body["email"] ?? "").toLowerCase();
      if (body["type"] !== "sign-in") return { status: 400, body: { message: "OpenOrc sends codes only to sign in." } };
      if (options.signup !== "open" && !(options.invited ?? []).includes(email)) return { status: 400, body: { code: "NOT_INVITED", message: NOT_INVITED } };
      codes.set(email, { code: String(randomInt(0, 1_000_000)).padStart(6, "0"), at: Date.now(), tries: 0 });
      return { status: 200, body: { success: true } };
    },
    "POST /api/auth/sign-out": (_body, token) => {
      if (holder(token)) sessions.delete(token!.split(".")[0]!);
      return { status: 200, body: { success: true } };
    },
    "GET /billing": (_body, token) => {
      const who = holder(token);
      return who ? { status: 200, body: billingState(billing.get(who) ?? { pro: false }) } : unauthorized();
    },
    // Better Auth answers null, not a 401, for a token whose session it no longer holds.
    "GET /api/auth/get-session": (_body, token) => {
      const who = holder(token);
      if (!who) return { status: 200, body: null };
      const person = people.get(who) ?? { name: nameFromEmail(who), image: null };
      return { status: 200, body: { session: { activeOrganizationId: `personal-${who}` }, user: { id: `user-${who}`, email: who, emailVerified: true, ...person } } };
    },
    "GET /agent-sign-ins": (_body, token) => {
      const who = holder(token);
      return who ? { status: 200, body: signInRows(signIns.get(who) ?? []) } : unauthorized();
    },
    "GET /settings/hosted": (_body, token) => {
      const who = holder(token);
      return who ? { status: 200, body: hostedSettings(who) } : unauthorized();
    },
    "PATCH /settings/hosted": (body, token) => {
      const who = holder(token);
      if (!who) return unauthorized();
      const service = body["service"] === null ? null : String(body["service"] ?? "");
      if (service && !services.includes(service)) return { status: 400, body: { message: `This server doesn't run threads on ${SERVICE_NAMES[service] ?? service}.`, statusCode: 400 } };
      sandboxes.set(who, service);
      return { status: 200, body: hostedSettings(who) };
    },
  };
  // The sign-in page mails the code as the apps ask for it, and the person reads it.
  const mail = (who: string): Reply & { code?: string } => ({ ...routes["POST /api/auth/email-otp/send-verification-otp"]!({ email: who, type: "sign-in" }, null), code: codes.get(who)?.code });
  return { codes, sessions, billing, people, sandboxes, signIns, admit, holder, routes, checkCode, session, mail };
}

export async function standIn(options: StandInOptions = {}): Promise<StandIn> {
  const { sessions, billing, people, sandboxes, signIns, admit: admitTurn, holder, routes, checkCode, session, mail } = accounts(options);
  const appSignIns = new StandInAppSignIns({ web: () => `http://127.0.0.1:${port}`, session, checkCode, mail });
  const requests: StandIn["requests"] = [];
  const connections = new Set<Socket>();
  const peers = new Set<Peer>();
  const sockets = new Set<StandInPeer>();
  const spaces = new StandInSpaces();
  const person = (email: string) => people.get(email) ?? { name: nameFromEmail(email), image: null };
  const hosted = new StandInThreads(() => [...[...peers].filter((peer) => !peer.waiting), ...sockets], admitTurn, spaces, person);
  const signInWrites = new StandInSignIns(signIns);
  const tell = tellOf(peers, sockets);
  const tasks = new StandInTasks({ spaces, person, tell, threads: hosted });
  const seats = new StandInSeats({ spaces, tell, now: options.now ?? Date.now, origin: () => `http://127.0.0.1:${port}` });
  const organizations = organizationReads(
    options,
    spaces,
    people,
    billing,
    tell,
    (space) => hosted.accessChanged(space),
    (space, who) => seats.frozen.words(space, who),
  );
  seats.assignments.person = person;
  seats.assignments.paysForPro = (who) => billing.get(who)?.pro === true;
  seats.frozen.access = (who) => billing.get(who)?.organizationAccess;
  organizations.invitations.seats = seats.holds;
  organizations.seat = (spaceId, who) => seats.assignments.fact(spaceId, who);
  const github = new StandInGithub(spaces, (who) => tell(who, ["projects", "github"]));
  const payments = new StandInPayments(billing, billingTopics(tell, organizations), () => `http://127.0.0.1:${port}`);
  const chat = new StandInChat({ spaces, person, peers: () => [...peers, ...sockets] });
  const uploads = new StandInUploads({ spaces, chat, origin: () => `http://127.0.0.1:${port}` });
  chat.attachFiles = (input) => uploads.attachChat(input);
  hosted.files.uploads = uploads;
  const parity = parityStandIns(spaces, () => hosted.files.capabilities);
  const answerSocket = socketAnswers(hosted, chat);

  const server = transportServer({ connections, requests, holder, sockets, answerSocket, answer });

  async function answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if ((await uploads.raw(request, response, holder)) || (await parity.skills.answer(request, response, holder))) return;
    const { method, path, query, body, token, space } = await asked(request);
    const who = holder(token);
    requests.push({ method, path, authorized: who !== null });
    const route = routes[`${method} ${path}`];
    const signedInRoute = async (): Promise<Reply | null> => {
      if (who)
        return (
          seats.route({ method, path, query, space }, who, body) ??
          tasks.route({ method, path, query, space }, who, body) ??
          parity.environment.route({ method, path, query, space }, who, body) ??
          chat.route({ method, path, query, space }, who, body) ??
          (await uploads.route(method, path, who, body, space)) ??
          (await organizations.route({ method, path, query, space }, who, body)) ??
          github.route(method, path, who, body, space) ??
          personRoutes(signInWrites, payments)(method, path, who, body) ??
          hosted.route({ method, path, query, space }, who, body)
        );
      return /^\/(account|spaces|organization|invitations|projects|hosted|chat|tasks|uploads|github|agent-sign-ins|billing|api\/auth\/organization)\b/.test(path) ? unauthorized() : null;
    };
    const old = tooOld(request.headers["x-openorc-protocol"]) ? { status: 426, body: { statusCode: 426, message: APP_TOO_OLD } } : null;
    const reply: Reply = old ?? (route ? route(body, token) : (appSignIns.route(method, path, body) ?? (await signedInRoute()))) ?? notFound(method, path);
    response.writeHead(reply.status, { "content-type": "application/json" });
    response.end(reply.body === null && reply.status !== 200 ? undefined : JSON.stringify(reply.body));
  }

  const admit = (peer: Peer) => admitPeer(peer, requests, holder);

  await listen(server, 0);
  const { port } = server.address() as AddressInfo;
  const { isServing, ...lifetime } = serverLifetime({ server, port, connections, peers, admit });

  return {
    url: `http://127.0.0.1:${port}`,
    seats,
    tasks,
    chat,
    uploads,
    ...parity,
    signInPage: (url, email) => appSignIns.signInPage(url, email.toLowerCase()),
    appSignIns,
    ...paymentsFace(billing, payments),
    setPerson: (email, person) => void people.set(email.toLowerCase(), person),
    sandboxes,
    ...threadsFace(hosted),
    github,
    spaces,
    organizations,
    addTeam: teamAdder(spaces),
    addProject: (email, project, space) => spaces.addProject(email.toLowerCase(), project, space),
    setSignIns: (email, rows) => void signIns.set(email.toLowerCase(), rows),
    approveDevice: (email) => signInWrites.approveDevice(email.toLowerCase()),
    signInSecrets: signInWrites.secrets,
    revoke: () => sessions.clear(),
    requests,
    ...lifetime,
    connect: (_url, token) => inProcessSocket(token, { holder, peers, admit, serving: isServing, answer: answerSocket }),
  };
}

function serverLifetime({ server, port, connections, peers, admit }: { server: ReturnType<typeof createServer>; port: number; connections: Set<Socket>; peers: Set<Peer>; admit(peer: Peer): void }) {
  let serving = true;
  return {
    isServing: () => serving,
    async down() {
      if (!serving) return;
      serving = false;
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const peer of peers) {
        peer.waiting = true;
        peer.emit("down");
      }
    },
    async up() {
      if (serving) return;
      await listen(server, port);
      serving = true;
      for (const peer of peers) if (peer.waiting) admit(peer);
    },
    async close() {
      peers.clear();
      for (const socket of connections) socket.destroy();
      if (serving) await new Promise<void>((resolve) => server.close(() => resolve()));
      serving = false;
    },
  };
}

/** What a cloud thread brings from the Mac, each behind its capability as the server keeps it behind its switch. */
function parityStandIns(spaces: StandInSpaces, capabilities: () => StandInThreadFiles["capabilities"]) {
  const on = (feature: string) => () => capabilities()?.[feature]?.available === true;
  return { skills: new StandInSkills({ spaces, available: on("skills") }), environment: new StandInEnvironment({ spaces, available: on("projectEnvironment") }) };
}

function teamAdder(spaces: StandInSpaces): StandIn["addTeam"] {
  return (name, members) =>
    spaces.addTeam(
      name,
      members.map((email) => email.toLowerCase()),
    );
}

/** A socket held in this process: the same rules as the WebSocket one, and its messages delivered a tick later. */
function inProcessSocket(
  token: string,
  server: { holder(token: string): string | null; peers: Set<Peer>; admit(peer: Peer): void; serving(): boolean; answer(peer: StandInPeer, event: string, body: unknown): unknown },
): LiveSocket {
  const listeners: ((state: "up" | "down" | "refused") => void)[] = [];
  const heard = new Map<string, ((body: unknown) => void)[]>();
  const peer: Peer = {
    token,
    waiting: true,
    watched: new Set(),
    who: () => server.holder(token),
    emit: (state) => listeners.forEach((listener) => listener(state)),
    send: (event, body) => queueMicrotask(() => heard.get(event)?.forEach((listener) => listener(structuredClone(body)))),
  };
  server.peers.add(peer);
  if (server.serving()) server.admit(peer);
  return {
    onState: (listener) => void listeners.push(listener),
    on: (event, listener) => void heard.set(event, [...(heard.get(event) ?? []), listener]),
    ask: async (event, body) => {
      if (peer.waiting || !server.peers.has(peer)) throw new Error("The socket is down.");
      return structuredClone(server.answer(peer, event, body));
    },
    close: () => void server.peers.delete(peer),
  };
}

/** The server's admission to start a turn: hours first, then a sign-in for the agent, and for OpenCode the provider its model names. */
function turnRule(billing: Map<string, StandInBilling>, signIns: Map<string, StandInSignIn[]>): Admit {
  return (who, settings) => {
    const state = billing.get(who) ?? { pro: false };
    if (!state.pro) return "not_pro";
    if (leftSeconds(state) <= 0) return state.monthlyLeftSeconds === null ? "awaiting_payment" : "no_hours";
    const provider = settings.agent === "opencode" ? (settings.model?.split("/")[0] ?? null) : null;
    if (settings.agent === "opencode" && !settings.model?.includes("/")) return null;
    const row = (signIns.get(who) ?? []).find((each) => each.agent === settings.agent && (provider === null || each.provider === provider));
    if (!row) return "no_sign_in";
    return row.ended ? "signed_out" : null;
  };
}

/** GET /agent-sign-ins: the person's sign-ins as the real server lists them, never a secret. */
function signInRows(rows: readonly StandInSignIn[]) {
  return rows.map((row) => ({
    agent: row.agent,
    kind: "subscription",
    provider: row.provider ?? (row.agent === "codex" ? "openai" : "anthropic"),
    label: row.label ?? "Subscription",
    checkedAt: row.checkedAt ?? new Date(0).toISOString(),
    expiresAt: null,
  }));
}

type PersonRoute = (method: string, path: string, who: string, body: Record<string, unknown>) => Reply | null;

/** The routes about the person alone, asked in turn: the first that serves the request answers it. */
function personRoutes(...routers: { route: PersonRoute }[]): PersonRoute {
  return (method, path, who, body) => routers.reduce<Reply | null>((reply, router) => reply ?? router.route(method, path, who, body), null);
}

/** Tells a person's sockets which space changed, defaulting personal topics to their own space. */
function tellOf(peers: Set<Peer>, sockets: Set<StandInPeer>): (who: string, topics: string[], space?: string) => void {
  return (who, topics, space = `personal-${who}`) => {
    for (const peer of [...peers, ...sockets]) if (peer.who() === who) peer.send("changed", { organizationId: space, topics });
  };
}

/** What a test does to people's billing, as Polar and the person's payments would. */
function paymentsFace(billing: Map<string, StandInBilling>, payments: StandInPayments): Pick<StandIn, "setBilling" | "checkouts" | "pay" | "setOffers"> {
  return {
    setBilling: (email, state) => void billing.set(email.toLowerCase(), state),
    checkouts: payments.checkouts,
    pay: (email, options) => payments.pay(email.toLowerCase(), options),
    setOffers: (offers) => void (payments.offers = offers),
  };
}

/** What a test does to the stand-in's threads, as an agent's host or another person would. */
function threadsFace(
  hosted: StandInThreads,
): Pick<StandIn, "addThread" | "append" | "set" | "stoppedCommands" | "ask" | "endTurn" | "readies" | "sent" | "answered" | "started" | "threadFiles" | "threadCollaboration"> {
  return {
    addThread: (email, seed) => hosted.addThread(email.toLowerCase(), seed),
    append: (threadId, events, options) => hosted.append(threadId, events, options),
    set: (threadId, facts) => hosted.set(threadId, facts),
    stoppedCommands: (threadId) => hosted.stoppedCommands(threadId),
    ask: (threadId, request) => hosted.ask(threadId, request),
    endTurn: (threadId, status) => hosted.endTurn(threadId, status),
    readies: hosted.readies,
    sent: hosted.sent,
    answered: hosted.answered,
    started: hosted.started,
    threadFiles: hosted.files,
    threadCollaboration: hosted.collaboration,
  };
}

/** What a request asks: its method, path and query, its body, its bearer token and the space it names. */
async function asked(request: IncomingMessage) {
  const url = new URL(request.url ?? "/", "http://stand-in");
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  const named = request.headers["x-openorc-space"];
  return {
    method: request.method ?? "GET",
    path: url.pathname,
    query: url.searchParams,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    token: /^bearer (.+)$/i.exec(request.headers.authorization ?? "")?.[1]?.trim() ?? null,
    space: typeof named === "string" ? named : null,
  };
}

/** Whether a protocol header names a version older than the oldest the server answers, or one it cannot read. None is not an app's. */
function tooOld(named: string | string[] | undefined): boolean {
  if (named === undefined) return false;
  const version = Number(named);
  return !Number.isInteger(version) || version < OLDEST_APP_PROTOCOL;
}

function codeRefused(status: number, code: keyof typeof CODE_REFUSALS): Reply {
  return { status, body: { code, message: CODE_REFUSALS[code] } };
}

function notFound(method: string, path: string): Reply {
  return { status: 404, body: { message: `Cannot ${method} ${path}`, error: "Not Found", statusCode: 404 } };
}

function unauthorized(): Reply {
  return { status: 401, body: { message: "Unauthorized", statusCode: 401 } };
}

function listen(server: ReturnType<typeof createServer>, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function admitPeer(peer: Peer, requests: StandIn["requests"], holder: (token: string) => string | null): void {
  requests.push({ method: "GET", path: SOCKET_PATH, authorized: holder(peer.token) !== null });
  peer.waiting = false;
  peer.watched.clear();
  queueMicrotask(() => peer.emit(holder(peer.token) ? "up" : "refused"));
}

function transportServer(deps: {
  connections: Set<Socket>;
  requests: StandIn["requests"];
  holder(token: string | null | undefined): string | null;
  sockets: Set<StandInPeer>;
  answerSocket(peer: StandInPeer, event: string, body: unknown): unknown;
  answer(request: IncomingMessage, response: ServerResponse): Promise<void>;
}) {
  const server = createServer((request, response) => void deps.answer(request, response));
  server.on("connection", (socket) => {
    deps.connections.add(socket);
    socket.once("close", () => deps.connections.delete(socket));
  });
  server.on("upgrade", (request, socket) => {
    deps.requests.push({ method: "GET", path: SOCKET_PATH, authorized: false });
    if (!request.url?.startsWith(SOCKET_PATH) || tooOld(request.headers["x-openorc-protocol"])) return void socket.destroy();
    engineSession(request, socket as Socket, { holder: deps.holder, joined: (peer) => deps.sockets.add(peer), left: (peer) => deps.sockets.delete(peer), answer: deps.answerSocket });
  });
  return server;
}

function billingTopics(tell: (who: string, topics: string[]) => void, organizations: StandInOrganizations) {
  return (who: string, topics: string[]) => {
    tell(who, topics);
    if (topics.includes("billing")) organizations.planChanged(who);
  };
}

function organizationReads(
  options: StandInOptions,
  spaces: StandInSpaces,
  people: Map<string, { name: string; image: string | null }>,
  billing: Map<string, StandInBilling>,
  tell: (who: string, topics: string[], space?: string) => void,
  accessChanged: (space: string) => void,
  accessMessage: (space: string, who: string) => string | null,
) {
  return new StandInOrganizations({
    spaces,
    creationAllowed: options.signup === "open",
    savePerson: (email, person) => void people.set(email, person),
    person: (email) => people.get(email) ?? { name: nameFromEmail(email), image: null },
    pro: (email) => {
      const state = billing.get(email);
      return Boolean(state?.pro && (state.standing === "live" || Date.parse(state.at) > (options.now ?? Date.now)()));
    },
    organizationAccess: (email) => billing.get(email)?.organizationAccess,
    accessMessage,
    tell,
    accessChanged,
    now: options.now ?? Date.now,
  });
}
