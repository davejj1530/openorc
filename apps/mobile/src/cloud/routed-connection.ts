import type { ClientPush, CoreConnection } from "@openorc/client";
import type { Hosted, HostedDeps } from "@openorc/hosted";
import type { KeptAnswers } from "../lists-cache";
import { PlaceRouter } from "@openorc/hosted/router";
import type { RpcMethod, RpcParams, RpcReply, RpcRequest, RpcResults, SpacesStatus } from "@openorc/protocol";

/** What a phone may not do with a space here, as the Mac shapes it for a phone: no invitations, no new organization. */
function phoneStatus(status: SpacesStatus): SpacesStatus {
  if (status.state !== "ready") return status;
  return { ...status, apiOrigin: "", invitations: [], create: { allowed: false, reason: "Create an organization in OpenOrc on your Mac." } };
}

/** What the router asks the Mac for a space's list: answered from the Mac's last word while it cannot answer. */
const KEPT: ReadonlySet<string> = new Set(["threads.list", "threads.resolvedCount"]);

/**
 * The Mac's side of the phone: its link, which answers for the Mac's own threads, folders and everything else, and
 * whether it has a session with the Mac now (`attached`); without one a call waits some seconds for one to come.
 */
export type MacLine = Pick<CoreConnection, "call" | "onPush" | "setFrameInterest"> & { readonly attached: boolean };

/**
 * The phone's one connection for its client state, as the Mac's place router makes one for its windows: while the
 * phone holds a session of OpenOrc Cloud of its own, the cloud answers for the threads it holds and adds its rows to the
 * lists, and the Mac, over the link, answers everything else, its own threads among them. The spaces, their projects,
 * the repositories a space may add as projects, who the person is and their cloud accounts come from the phone's own
 * session. With no session of its own, every call goes to the Mac, as before.
 */
export class RoutedConnection implements CoreConnection {
  readonly delivery = "interest";
  private nextId = 0;
  private readonly listeners = new Set<(push: ClientPush) => void>();
  private readonly router: PlaceRouter;
  /** A list was answered from the Mac's last word while the Mac was away, so it is read again once the Mac is back. */
  private answeredAway = false;
  constructor(
    private readonly mac: MacLine,
    private readonly cloud: { readonly hosted: Hosted | null },
    /** The Mac's last answers to its lists, kept across launches by the app; in memory alone by default. */
    private readonly lastHeard: KeptAnswers = new Map(),
  ) {
    this.router = new PlaceRouter({
      place: () => this.signedIn()?.threads ?? null,
      spaces: () => this.signedIn()?.spaces ?? null,
      chat: () => this.signedIn()?.chat ?? null,
      next: (request) => this.toMac(request),
    });
    mac.onPush((push) => {
      this.emit(push);
      if (push.type !== "session" || !this.answeredAway) return;
      this.answeredAway = false;
      this.emit({ type: "invalidate", keys: ["threads"] });
    });
  }

  call<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> {
    const hosted = this.signedIn();
    if (!hosted) return this.mac.call(method, params);
    const own = this.own(hosted, method, params);
    if (own) return own as Promise<RpcResults[M]>;
    return this.router.handle({ type: "rpc", id: ++this.nextId, method, params }).then((reply) => {
      if (reply.type === "rpc.error") throw new Error(reply.message);
      return reply.result as RpcResults[M];
    });
  }

  onPush(listener: (push: ClientPush) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  setFrameInterest(runIds: ReadonlySet<string>): void {
    // The cloud follows the threads the phone reads, as it does for the Mac's windows; the Mac needs telling.
    this.mac.setFrameInterest(runIds);
  }

  /** What the phone's own OpenOrc Cloud tells it: lists that changed, a thread's frames and gaps in them. */
  readonly cloudPush: HostedDeps["push"] = (push) => {
    if (push.type === "invalidate" || push.type === "frame" || push.type === "gap") this.emit(push);
  };

  private signedIn(): Hosted | null {
    const hosted = this.cloud.hosted;
    return hosted?.account.status().state === "signed-in" ? hosted : null;
  }

  /** The account's own answers, which the Mac gave a phone reading the cloud through it. */
  private own(hosted: Hosted, method: RpcMethod, params: unknown): Promise<unknown> | null {
    switch (method) {
      case "spaces.status":
        return Promise.resolve(phoneStatus(hosted.spaces.status()));
      case "spaces.projects":
        return hosted.spaces.projects((params as RpcParams<"spaces.projects">).spaceId);
      case "account.status":
        return Promise.resolve(hosted.account.status());
      case "organization.repositories":
        return hosted.spaces.setup.repositories((params as RpcParams<"organization.repositories">).spaceId);
      case "organization.projects.add":
        return hosted.spaces.setup.addProjects(params as RpcParams<"organization.projects.add">);
      case "account.person": {
        const status = hosted.account.status();
        return Promise.resolve(status.state === "signed-in" ? { name: status.name ?? null, image: status.image ?? null } : null);
      }
      default:
        return null;
    }
  }

  /**
   * A call the cloud does not hold, to the Mac. A list or a count the Mac cannot answer now (asleep, out of reach)
   * answers with what it last said for the same call, or nothing, so the cloud's rows still list beside it. With no
   * session open it answers so at once: the cloud's rows never wait out the link's wait for a Mac that is away, and
   * the lists are read again when its session starts.
   */
  private toMac(request: RpcRequest): Promise<RpcReply> {
    const key = KEPT.has(request.method) ? JSON.stringify([request.method, request.params]) : null;
    const kept = (): RpcReply => ({ type: "rpc.result", id: request.id, result: this.lastHeard.get(key ?? "") ?? (request.method === "threads.list" ? [] : 0) });
    if (key && !this.mac.attached) {
      this.answeredAway = true;
      return Promise.resolve(kept());
    }
    return this.mac.call(request.method as RpcMethod, request.params as never).then(
      (result): RpcReply => {
        if (key) this.lastHeard.set(key, result);
        return { type: "rpc.result", id: request.id, result };
      },
      (error: unknown): RpcReply => (key ? kept() : { type: "rpc.error", id: request.id, message: error instanceof Error ? error.message : String(error) }),
    );
  }

  private emit(push: ClientPush): void {
    this.listeners.forEach((listener) => listener(push));
  }
}
