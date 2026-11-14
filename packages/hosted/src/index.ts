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
  OwnerReach,
  Project,
  RoutedMethod,
  RpcParams,
  RpcResults,
  ThreadSummary,
} from "@openorc/protocol";
import { Account } from "./account.js";
import { Follower } from "./follow.js";
import type { HostedNotice } from "./notices.js";
import { Session } from "./session.js";
import { Threads } from "./threads.js";
import { Spaces } from "./spaces.js";

/** The server's push socket, as little of it as the package uses. The desktop core builds one from `socket.io-client`. */
export interface LiveSocket {
  /** `up` on every new session, `down` when it drops, `refused` when the server will not take the token. */
  onState(listener: (state: "up" | "down" | "refused") => void): void;
  /** A message the server sends. */
  on(event: string, listener: (body: unknown) => void): void;
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
   * Keeps what the server last said that is no secret, in two parts (the account's plan and hours, and its thread
   * rows), so they show offline and after a restart.
   */
  kept: { load(part: KeptPart): string | null; save(part: KeptPart, json: string | null): void };
  /** This device's projects with their git remotes. Hosted projects are matched to them by GitHub repository. */
  projects(): readonly { id: string; name?: string; remote: string | null }[];
  fetch: typeof fetch;
  /** Opens the socket with the token. Called again after each sign-in and each early reconnect; it retries by itself in between. */
  connect(url: string, token: string): LiveSocket;
  /** What the host's windows hear. Frames carry the app's run ids. Never reaches a paired phone. */
  push(push: { type: "invalidate"; keys: string[] } | { type: "frame"; frame: Frame } | { type: "gap"; runIds: string[] }): void;
  /** A notice for the person about a cloud thread: an ask it waits on, or a turn that ended. The host words and shows it as its own. */
  notify(notice: HostedNotice): void;
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
  /** Chooses the sandbox service the person's cloud threads run on; null leaves it to the server. */
  setSandbox(service: string | null): Promise<void>;
  /** Signs an agent in on OpenOrc Cloud, one of its ways; what goes on after this resolves shows in `status().signingIn`. */
  connectSignIn(input: RpcParams<"account.signIns.connect">): Promise<void>;
  cancelSignIn(agent: HostedAgent): void;
  removeSignIn(input: RpcParams<"account.signIns.remove">): Promise<void>;
  /** Connects the person's GitHub through as many browser trips as it takes; resolves once the first page is open, the rest shows in `status().connectingGithub`. */
  connectGithub(): Promise<void>;
  cancelGithub(): void;
  /** Unlinks the person's GitHub account. */
  disconnectGithub(): Promise<void>;
  /** Adds a Mac project's GitHub repository to the person's space as a cloud project. Rejects in words when GitHub doesn't let OpenOrc read it. */
  addProject(projectId: string): Promise<void>;
  /** Opens a checkout or the billing portal in the browser; what it was for shows in `status()` once the server has it. */
  openBilling(page: BillingPage): Promise<void>;
  /** Stops watching for a purchase more often than the server's word; `status().paying` ends. */
  leaveBilling(): void;
  /** What Pro and an hours pack cost, read from the server; null signed out, or when it can't say. */
  offers(): Promise<BillingOffers | null>;
}

export interface HostedSpaces {
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
    connect(spaceId: string): Promise<RpcResults["organization.github.connect"]>;
    addProjects(input: RpcParams<"organization.projects.add">): Promise<RpcResults["organization.projects.add"]>;
  };
  status(): SpacesStatus;
  projects(spaceId: string): Promise<SpaceProject[]>;
  people(spaceId: string, offset?: number, limit?: number): Promise<OrganizationPeople>;
}

export type KeptPart = "account" | "threads" | "spaces";

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
  /** One of the app's calls about something it holds, in the app's shapes. Rejects with words for the person. */
  call<M extends RoutedMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]>;
  /** A project only the server has, as a window reads a project. */
  project(id: string): Project | null;
  /** This place's rows of a merged list, from what it last heard, at once. Null with none to add. */
  listed<M extends MergedMethod>(method: M, params: RpcParams<M>): PlacePage<M> | null;
}

export type { HostedNotice, ThreadSummary };

export interface Hosted {
  readonly account: HostedAccount;
  readonly threads: HostedThreads;
  readonly spaces: HostedSpaces;
  /** Reads the stored session and the kept answers, and connects when signed in. Never rejects: no session is signed out. */
  start(): Promise<void>;
  /** The device woke or the network came back: connect now instead of at the next retry. */
  awoke(): void;
  close(): void;
}

export function createHosted(deps: HostedDeps): Hosted {
  const session = new Session(deps);
  const spaces = new Spaces({ ...deps, session });
  // The account says which of this Mac's projects are on OpenOrc Cloud, from the projects the thread rows were read with.
  const cloud = {
    repos: () => threads.cloudRepos(),
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
  const follower: Follower = new Follower({ session, on: (threadId) => threads.on(threadId), push: deps.push, log: deps.log });
  const threads: Threads = new Threads({
    session,
    spaces,
    follower,
    account,
    server: deps.server,
    kept: deps.kept,
    projects: deps.projects,
    push: deps.push,
    notify: deps.notify,
    now: deps.now,
    log: deps.log,
  });
  return {
    account,
    threads,
    spaces,
    start: async () => {
      await account.start();
      threads.start();
    },
    awoke: () => {
      session.awoke();
      void spaces.refresh();
      void threads.refresh();
    },
    close: () => {
      account.close();
      spaces.close();
      threads.close();
      session.close();
    },
  };
}
