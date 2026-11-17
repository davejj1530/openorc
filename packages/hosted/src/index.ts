/**
 * OpenOrc Cloud, as the app speaks to it. The whole public surface of the package: `exports` in package.json names this
 * file and the test stand-in, so session.ts, wire.ts, account.ts and translate.ts cannot be imported from outside.
 *
 * What it hides: the server's routes and their shapes, the bearer token, the socket and reach. What it shows: the
 * app's own protocol types and nothing of the server's.
 *
 * No Node, Electron or React Native import outside testing/. Each host hands in what only it has (`HostedDeps`), so a
 * phone can mount the same package with its own storage.
 */
import type {
  AccountStatus,
  OrganizationPeople,
  SpaceProject,
  SpacesStatus,
  BillingOffers,
  BillingPage,
  Frame,
  HostedAgent,
  HostedTerminalPush,
  OwnerReach,
  Project,
  RoutedMethod,
  RpcParams,
  RpcResults,
  ThreadSummary,
} from "@openorc/protocol";
import { Account } from "./account.js";
import { OrganizationBilling } from "./organization-billing.js";
export type { OrganizationSeatAdministration } from "./organization-seat-administration.js";
import { TeamChat } from "./chat.js";
import { Follower } from "./follow.js";
import { Files } from "./files.js";
import { Skills, type OwnSkills } from "./skills.js";
import { ProjectEnvironment } from "./environment.js";
import type { MacWorkUpload } from "./mac-start.js";
export type { MacWorkUpload } from "./mac-start.js";
import { CloudConnectors } from "./connectors.js";
import { CloudMachines } from "./machines.js";
import { CloudCheckRuns } from "./cloud-check.js";
import { CloudMacProjects } from "./mac-projects.js";
export { githubRepoOf } from "./translate.js";
export { signInVerifier } from "./browser-sign-in.js";
import type { HostedNotice } from "./notices.js";
import { Session } from "./session.js";
import { Threads } from "./threads.js";
import { Spaces } from "./spaces.js";
import { OnlineTasks } from "./tasks.js";

export { OnlineTasks } from "./tasks.js";
export type { CloudFileScope, CloudFileReference, FileDestination } from "./files.js";
export type { FileByteSource } from "./file-transfer.js";
export type { UploadPlan, UploadedFile } from "./wire-files.js";
export type { OwnSkill, OwnSkills } from "./skills.js";

/** The server's push socket, as little of it as the package uses. The desktop core builds one from `socket.io-client`. */
export interface LiveSocket {
  /** `up` on every new session, `down` when it drops, `refused` when the server will not take the token. */
  onState(listener: (state: "up" | "down" | "refused") => void): void;
  /** A message the server sends; `answer` is there when the server asks for a reply to it. */
  on(event: string, listener: (body: unknown, answer?: (reply: unknown) => void) => void): void;
  /** Sends one message and resolves with the server's reply to it. Rejects when the socket is down or drops first. */
  ask(event: string, body: unknown): Promise<unknown>;
  close(): void;
}

/** What only the host has. Everything else is the package's own. */
export interface HostedDeps {
  /** The server's origin. Tests pass their stand-in's. */
  server: string;
  /**
   * Keeps the signed-in session (its token and address, as one opaque value) in protected storage. The package reads
   * it once at start, holds it in memory, and never returns, logs or throws the token. `save(null)` forgets it.
   */
  session: { load(): Promise<string | null>; save(value: string | null): Promise<void> };
  /**
   * Keeps account summaries, thread and space rows, and pending billing requests across launches.
   * Credentials remain in the separate protected session store.
   */
  kept: { load(part: KeptPart): string | null; save(part: KeptPart, json: string | null): void };
  /**
   * This device's projects with their git remotes. Hosted projects are matched to them by GitHub repository, and a
   * folder with no remote by the Personal project it was added as (`cloudProjectId`).
   */
  projects(): readonly { id: string; name?: string; remote: string | null; cloudProjectId?: string | null }[];
  /**
   * A project folder's work packed for a cloud thread started from it (mac-start.ts): null when it holds nothing GitHub
   * lacks. `include` names held-back files to send after all.
   */
  macWork?(projectId: string, include: readonly string[]): Promise<MacWorkUpload | null>;
  fetch: typeof fetch;
  /** Opens the socket with the token. Called again after each sign-in and each early reconnect; it retries by itself in between. */
  connect(url: string, token: string): LiveSocket;
  /** What the host's windows hear. Frames carry the app's run ids. Never reaches a paired phone. */
  push(push: { type: "invalidate"; keys: string[] } | { type: "frame"; frame: Frame } | { type: "gap"; runIds: string[] } | HostedTerminalPush): void;
  /** A notice for the person about a cloud thread: an ask it waits on, or a turn that ended. The host words and shows it as its own. */
  notify(notice: HostedNotice): void;
  /** The host's shared small-model naming rule. Its proposal is saved only while the expected title still matches. */
  nameThread?(thread: Pick<ThreadSummary, "id" | "title" | "agent">, exchange: { prompt: string | null; reply: string | null }): Promise<{ title: string; expectedTitle: string } | null>;
  /**
   * Makes a long-lived Claude token as one of the device's Claude accounts (its default when none is named), as the
   * Mac's `claude setup-token` does. Absent where the device cannot; the token goes to the server and nowhere else.
   */
  mintClaudeToken?(claudeAccountId: string | undefined): { token: Promise<string>; cancel(): void };
  /**
   * The person's browser, for OpenOrc's sign-in page and GitHub's and Polar's pages: waits on this device's loopback
   * for one return to `path` (its query, or a rejection on timeout or `close`), and opens a page. Absent where the
   * device has neither.
   */
  browser?: {
    awaitReturn(path: string, timeoutMs: number, waitForResult?: boolean): Promise<{ port: number; query: Promise<string>; redirect(url: string): void; close(): void }>;
    open(url: string): void;
  };
  /** What the sign-in page calls this device, such as "OpenOrc on this Mac". */
  deviceName: string;
  /**
   * Whether someone used this computer's keyboard or mouse in the last two minutes, which OpenOrc Cloud asks when it
   * would alert the person's phone, as the Mac's own alerts hold back. Without it the device answers that nobody is.
   */
  inUse?(): Promise<boolean>;
  /**
   * The person's own skills for an agent on this device, which their cloud turns get where the server serves skills.
   * Absent where the device has none to give. It rejects in words when they cannot be read.
   */
  skills?: OwnSkills;
  now(): number;
  log: { info(message: string): void; warn(message: string): void };
}

/** The account: who is signed in and what they pay for. */
export interface HostedAccount {
  /** What is known now, without waiting. Changes are announced with `invalidate ["account"]`. */
  status(): AccountStatus;
  /**
   * Opens OpenOrc's sign-in page in the browser; resolves once it is open, and what comes of it shows in
   * `status().signingIn` until the session is in protected storage. Nothing to do when signed in.
   */
  signIn(): Promise<void>;
  cancelSigningIn(): void;
  /** Forgets the session and the kept answers first, then tells the server, so a server out of reach still signs out here. */
  signOut(): Promise<void>;
  /**
   * As the signed-in person, grants another of their devices, such as their phone, a session of its own: the server
   * answers a one-time code for the challenge of a verifier only that device holds, which it trades with
   * `signInWithGrant`. The code lasts `expiresInMs`. Refused in words when signed out.
   */
  grantSignIn(input: { challenge: string; device: string }): Promise<{ request: string; code: string; expiresInMs: number }>;
  /**
   * Signs this device in with a code another of the person's devices was granted for it, and the verifier behind that
   * grant's challenge (`signInVerifier`). Nothing to do when signed in: the grant is given up.
   */
  signInWithGrant(input: { request: string; code: string; verifier: string }): Promise<void>;
  /** Saves and keeps the stored profile from the reply; subsequent reads cannot make this write fail. */
  updateProfile(input: RpcParams<"account.profile.update">): Promise<void>;
  /** Chooses the sandbox service the person's cloud threads run on; null leaves it to the server. */
  setSandbox(service: string | null): Promise<void>;
  /** Signs an agent in on OpenOrc Cloud, one of its ways; what goes on after this resolves shows in `status().signingIn`. */
  connectSignIn(input: RpcParams<"account.signIns.connect">): Promise<void>;
  cancelSignIn(agent: HostedAgent): void;
  removeSignIn(input: RpcParams<"account.signIns.remove">): Promise<void>;
  /** Connects the person's GitHub through as many browser trips as it takes; resolves once the first page is open, the rest shows in `status().connectingGithub`. */
  connectGithub(input?: RpcParams<"account.github.connect">): Promise<void>;
  cancelGithub(): void;
  /** Unlinks the person's GitHub account. */
  disconnectGithub(): Promise<void>;
  /** Opens a checkout or the billing portal in the browser; what it was for shows in `status()` once the server has it. */
  openBilling(page: BillingPage): Promise<void>;
  /** Stops watching for a purchase more often than the server's word; `status().paying` ends. */
  leaveBilling(): void;
  /** What Pro and an hours pack cost, read from the server; null signed out, or when it can't say. */
  offers(): Promise<BillingOffers | null>;
}

export interface HostedSpaces {
  readonly received: {
    accept(invitationId: string): Promise<RpcResults["spaces.invitation.accept"]>;
    decline(invitationId: string): Promise<RpcResults["spaces.invitation.decline"]>;
  };
  refresh(): Promise<void>;
  /** The usable organizations where a note tags the person unread. */
  mentions(): Promise<RpcResults["spaces.mentions"]>;
  readonly invitations: {
    list(spaceId: string): Promise<RpcResults["organization.invitations"]>;
    send(input: RpcParams<"organization.invite">): Promise<RpcResults["organization.invite"]>;
    resend(input: RpcParams<"organization.invitation.resend">): Promise<RpcResults["organization.invitation.resend"]>;
    revoke(input: RpcParams<"organization.invitation.revoke">): Promise<RpcResults["organization.invitation.revoke"]>;
  };
  readonly access: {
    get(input: RpcParams<"organization.project.access">): Promise<RpcResults["organization.project.access"]>;
    set(input: RpcParams<"organization.project.setAccess">): Promise<RpcResults["organization.project.setAccess"]>;
  };
  readonly membership: {
    setRole(input: RpcParams<"organization.member.setRole">): Promise<RpcResults["organization.member.setRole"]>;
    remove(input: RpcParams<"organization.member.remove">): Promise<RpcResults["organization.member.remove"]>;
    leave(input: RpcParams<"organization.leave">): Promise<RpcResults["organization.leave"]>;
    delete(input: RpcParams<"organization.delete">): Promise<RpcResults["organization.delete"]>;
  };
  readonly setup: {
    create(input: RpcParams<"spaces.create">): Promise<RpcResults["spaces.create"]>;
    update(input: RpcParams<"organization.update">): Promise<RpcResults["organization.update"]>;
    repositories(spaceId: string): Promise<RpcResults["organization.repositories"]>;
    connect(spaceId: string, choice?: Omit<RpcParams<"organization.github.connect">, "spaceId">): Promise<RpcResults["organization.github.connect"]>;
    addProjects(input: RpcParams<"organization.projects.add">): Promise<RpcResults["organization.projects.add"]>;
    removeProject(input: RpcParams<"organization.projects.remove">): Promise<RpcResults["organization.projects.remove"]>;
  };
  status(): SpacesStatus;
  projects(spaceId: string): Promise<SpaceProject[]>;
  people(spaceId: string, offset?: number, limit?: number): Promise<OrganizationPeople>;
}

export type KeptPart = "account" | "threads" | "spaces" | "organizationBilling" | "seatOperations" | "seatQuantity";

/** The lists every place answers its own rows of, which the asker merges. */
export type MergedMethod = "threads.list" | "threads.resolvedCount" | "inbox.list";

/** One place's part of a merged list, with how far the place could be reached when it last answered. */
export interface PlacePage<M extends MergedMethod> {
  reach: OwnerReach;
  heardAt: number;
  rows: RpcResults[M];
}

/**
 * Hosted threads, in the app's own calls: the place the core's router asks. Nothing here names a seq, a turn, a room,
 * a route or a space.
 */
export interface HostedThreads {
  readonly brain: "hosted";
  /** Signed in and heard from. While false the router asks nothing of this place. */
  readonly active: boolean;
  /** Whether a thread, run or project is the account's. A lookup in what the server listed; never a request. */
  holds(ref: { thread: string } | { run: string } | { project: string }): boolean;
  /** A thread the account has, as last heard: its id, its space, and its cloud project. Rejects in words for one it lacks. */
  row?(threadId: string): { id: string; space: string; projectId: string | null };
  /** The threads the account has of one cloud project, as last heard. */
  rowsOfProject?(projectId: string): { id: string; space: string; projectId: string | null }[];
  /** One of the app's calls about something it holds, in the app's shapes. Rejects with words for the person. */
  call<M extends RoutedMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]>;
  /** A project only the server has, as a window reads a project. */
  project(id: string): Project | null;
  /** Whether a cloud thread of this Mac project may start from its folder (mac-start.ts). */
  macStartOffered?(macProjectId: string, spaceId?: string): Promise<boolean>;
  /** This place's rows of a merged list, from what it last heard, at once. Null with none to add. */
  listed<M extends MergedMethod>(method: M, params: RpcParams<M>): PlacePage<M> | null;
}

export type { HostedNotice, ThreadSummary };

export interface Hosted {
  readonly account: HostedAccount;
  readonly organizationBilling: OrganizationBilling;
  readonly threads: HostedThreads;
  readonly spaces: HostedSpaces;
  readonly chat: TeamChat;
  readonly tasks: OnlineTasks;
  readonly files: Files;
  /** A cloud project's own environment variables, read by name and set by value. */
  readonly environment: ProjectEnvironment;
  /** The person's own connectors in their cloud turns, saved by value and read by header name. */
  readonly connectors: CloudConnectors;
  /** The person's machines awake now, and their stop. */
  readonly machines: CloudMachines;
  /** The person's cloud check, read and started. */
  readonly check: CloudCheckRuns;
  /** Personal projects from a folder of this Mac with no remote, and their threads' work for the folder. */
  readonly macProjects: CloudMacProjects;
  /** Reads the stored session and the kept answers, and connects when signed in. Never rejects: no session is signed out. */
  start(): Promise<void>;
  /** The device woke or the network came back: connect now instead of at the next retry. */
  awoke(): void;
  close(): void;
}

/** What a cloud thread brings from this Mac and what runs for the person there, each over the session alone. */
function parityServices(session: Session, now: HostedDeps["now"]): Pick<Hosted, "environment" | "connectors" | "machines" | "check" | "macProjects"> {
  return {
    environment: new ProjectEnvironment({ session, now }),
    connectors: new CloudConnectors({ session }),
    machines: new CloudMachines({ session }),
    check: new CloudCheckRuns({ session }),
    macProjects: new CloudMacProjects({ session }),
  };
}

export function createHosted(deps: HostedDeps): Hosted {
  const session = new Session(deps);
  // A change of organization access, a grace deadline passing included, opens or closes their threads too.
  const spaces = new Spaces({
    ...deps,
    session,
    accessChanged: () => {
      void account.reread();
      void threads.refresh();
    },
  });
  const organizationBilling = new OrganizationBilling({
    ...deps,
    session,
    spaces,
    storage: { load: () => deps.kept.load("organizationBilling"), save: (value) => deps.kept.save("organizationBilling", value) },
    operations: { load: () => deps.kept.load("seatOperations"), save: (value) => deps.kept.save("seatOperations", value) },
    quantityOperations: { load: () => deps.kept.load("seatQuantity"), save: (value) => deps.kept.save("seatQuantity", value) },
  });
  const chat = new TeamChat({ session, spaces, push: deps.push });
  const tasks = new OnlineTasks({ session, spaces, push: deps.push, prepared: () => threads.refresh() });
  const files = new Files({ session, spaces, fetch: deps.fetch, push: deps.push });
  const skills = new Skills({ session, own: deps.skills, now: deps.now });
  // The account says which of this Mac's projects are on OpenOrc Cloud, from the projects the thread rows were read with.
  const cloud = {
    repos: () => threads.cloudRepos(),
    ids: () => threads.cloudIds(),
    reread: async () => {
      await spaces.refresh();
      await threads.refresh();
    },
  };
  const account = new Account({
    session,
    server: deps.server,
    kept: deps.kept,
    push: deps.push,
    now: deps.now,
    mintClaudeToken: deps.mintClaudeToken,
    browser: deps.browser,
    deviceName: deps.deviceName,
    projects: deps.projects,
    cloud,
  });
  // The follower reads a thread's log in the thread's space, which the rows know.
  const follower: Follower = new Follower({
    session,
    on: (threadId) => threads.on(threadId),
    completed: (id, seq) => threads.completed(id, seq),
    observed: (id, events) => threads.observed(id, events),
    push: deps.push,
    log: deps.log,
  });
  const threads: Threads = new Threads({
    session,
    spaces,
    follower,
    account,
    skills,
    server: deps.server,
    kept: deps.kept,
    projects: deps.projects,
    ...(deps.macWork && { macWork: deps.macWork }),
    push: deps.push,
    notify: deps.notify,
    nameThread: deps.nameThread,
    now: deps.now,
    log: deps.log,
  });
  return {
    account,
    organizationBilling,
    threads,
    spaces,
    chat,
    tasks,
    files,
    ...parityServices(session, deps.now),
    start: async () => {
      await account.start();
      threads.start();
    },
    awoke: () => {
      session.awoke();
      void organizationBilling.awoke();
      void spaces.refresh();
      void threads.refresh();
    },
    close: () => {
      organizationBilling.close();
      account.close();
      spaces.close();
      threads.close();
      chat.close();
      tasks.close();
      files.close();
      session.close();
    },
  };
}
