/**
 * The first stop of every window call: places besides this Mac that hold threads by lookup answer for what they hold,
 * and add their rows to the lists. OpenOrc Cloud is the one such place. Phones never come here.
 *
 * Invariants:
 *   1. With no active place, `handle` is `next`: the same call, so an app with no account runs the code it ran before.
 *   2. A place is asked only about ids it said it holds, so a thread of this Mac never reaches it.
 *   3. Lists never wait on a place: its rows come from what it last heard.
 *   4. A start that asks for OpenOrc Cloud goes to it, and never to this Mac, which would start the thread somewhere
 *      the person did not choose.
 */
import type { HostedSpaces, HostedThreads } from "../index.js";
import {
  mergeThreadPages,
  ownerRoute,
  rpcParams,
  type RoutedMethod,
  type RpcMethod,
  type RpcParams,
  type RpcReply,
  type RpcRequest,
  type ThreadSearchHit,
  type ThreadSummary,
} from "@openorc/protocol";
import { SpaceRequests } from "./space-requests.js";
import { HostedCallGuard, heldHereCall } from "./hosted-call-guard.js";

export interface PlaceRouterDeps {
  /** The place, or null while there is none (no account server). */
  place(): HostedThreads | null;
  spaces?(): Pick<HostedSpaces, "status" | "projects" | "people"> | null;
  /** What answers a call no place holds: this Mac's own dispatch. */
  next(request: RpcRequest): Promise<RpcReply>;
}

export class PlaceRouter {
  private readonly hostedOwnership = new HostedCallGuard();
  private readonly scoped = new SpaceRequests({ spaces: () => this.deps.spaces?.() ?? null, place: () => this.deps.place(), next: (request) => this.deps.next(request) });
  constructor(private readonly deps: PlaceRouterDeps) {}

  handle(request: RpcRequest): Promise<RpcReply> {
    const place = this.deps.place();
    if (!Object.hasOwn(rpcParams, request.method)) return this.deps.next(request);
    const method = request.method as RpcMethod;
    const parsed = rpcParams[method].safeParse(request.params ?? {});
    // The Mac words a refusal of params, as before.
    if (!parsed.success) return this.deps.next(request);
    const params = parsed.data as Record<string, unknown>;
    const refusal = this.hostedOwnership.refusal(place, method, params);
    if (refusal) return Promise.resolve({ type: "rpc.error", id: request.id, message: refusal });
    if (typeof params["spaceId"] === "string" && ["threads.list", "threads.resolvedCount", "threads.search", "threads.start", "tasks.list"].includes(method))
      return this.scoped.handle(request, params["spaceId"]);
    if (method.startsWith("hosted.")) return this.hostedRequest(place, request, method as RoutedMethod, params);
    if (!place?.active) return this.deps.next(request);
    if (method === "projects.get" && place.holds({ project: String(params["id"]) })) return Promise.resolve(result(request, place.project(String(params["id"]))));
    if (method === "threads.start" && params["hosted"]) return this.asked(place, request, "threads.start", params);
    return this.routed(place, request, method, params);
  }

  private hostedRequest(place: HostedThreads | null, request: RpcRequest, method: RoutedMethod, params: Record<string, unknown>): Promise<RpcReply> {
    const id = params["threadId"];
    if (place?.active && typeof id === "string" && place.holds({ thread: id })) return this.asked(place, request, method, params);
    return Promise.resolve({ type: "rpc.error", id: request.id, message: "That conversation isn't available on OpenOrc Cloud." });
  }

  /** A call that names a thread, a run or a list: the place answers what it holds; anything else goes on as before. */
  private routed(place: HostedThreads, request: RpcRequest, method: RpcMethod, params: Record<string, unknown>): Promise<RpcReply> {
    const route = ownerRoute(method);
    if (!route) return this.deps.next(request);
    const ask = () => this.asked(place, request, method as RoutedMethod, params);
    if (route.by === "here" && heldHereCall(place, method, params)) return ask();
    switch (route.by) {
      case "owner": {
        const id = route.thread(params as never);
        return id && place.holds({ thread: id }) ? ask() : this.deps.next(request);
      }
      case "run":
        return place.holds({ run: route.run(params as never) }) ? ask() : this.deps.next(request);
      case "merge": {
        const id = route.thread?.(params as never);
        if (id) return place.holds({ thread: id }) ? ask() : this.deps.next(request);
        if (method === "threads.list") return this.list(place, request, params as RpcParams<"threads.list">);
        if (method === "threads.resolvedCount") return this.resolvedCount(place, request, params as RpcParams<"threads.resolvedCount">);
        if (method === "threads.search") return this.search(place, request, params as RpcParams<"threads.search">);
        return this.deps.next(request);
      }
      default:
        return this.deps.next(request);
    }
  }

  /** One call to the place as a reply. Never rejects: the place's rejection becomes an error with its words. */
  private async asked(place: HostedThreads, request: RpcRequest, method: RoutedMethod, params: Record<string, unknown>): Promise<RpcReply> {
    try {
      return result(request, await place.call(method, params as RpcParams<typeof method>));
    } catch (error) {
      return { type: "rpc.error", id: request.id, message: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * This Mac's rows and the place's, through the protocol's own merge. A later page asks everyone from 0 to its end
   * and slices, so the merged top `limit` is exact.
   */
  private async list(place: HostedThreads, request: RpcRequest, params: RpcParams<"threads.list">): Promise<RpcReply> {
    const page = place.listed("threads.list", params);
    if (!page?.rows.length) return this.deps.next(request);
    const offset = params.offset ?? 0;
    const asked = { ...params, offset: 0, ...(params.limit !== undefined && { limit: offset + params.limit }) };
    const base = await this.deps.next({ ...request, params: asked });
    if (base.type === "rpc.error") return base;
    const rows = mergeThreadPages(
      [
        { brain: "mac", reach: "live", heardAt: Date.now(), rows: base.result as ThreadSummary[] },
        { brain: "hosted", ...page },
      ],
      asked,
      "mac",
    );
    return result(request, rows.slice(offset));
  }

  /** Message search with no space chosen: this Mac's hits and those of every cloud thread the account lists, newest first. */
  private async search(place: HostedThreads, request: RpcRequest, params: RpcParams<"threads.search">): Promise<RpcReply> {
    if (!place.search) return this.deps.next(request);
    try {
      const [base, cloud] = await Promise.all([this.deps.next(request), place.search(undefined, params)]);
      if (base.type === "rpc.error") return base;
      const hits = [...(base.result as ThreadSearchHit[]), ...cloud].sort((a, b) => b.ts - a.ts || a.messageId.localeCompare(b.messageId));
      return result(request, hits.slice(0, params.limit ?? 30));
    } catch (error) {
      return { type: "rpc.error", id: request.id, message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Resolved's count: this Mac's and the place's quiet rows, so the count and the drawer agree. */
  private async resolvedCount(place: HostedThreads, request: RpcRequest, params: RpcParams<"threads.resolvedCount">): Promise<RpcReply> {
    const base = await this.deps.next(request);
    const page = place.listed("threads.resolvedCount", params);
    if (base.type === "rpc.error" || !page) return base;
    return result(request, (base.result as number) + page.rows);
  }
}

function result(request: RpcRequest, value: unknown): RpcReply {
  return { type: "rpc.result", id: request.id, result: value ?? null };
}
