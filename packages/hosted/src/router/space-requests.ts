import type { HostedSpaces, HostedThreads } from "../index.js";
import { mergeThreadPages, rpcParams, WORKSPACE_ID, type RpcMethod, type RpcParams, type RpcReply, type RpcRequest, type RpcResults, type SpaceProject } from "@openorc/protocol";

interface Dependencies {
  spaces(): Pick<HostedSpaces, "status" | "projects" | "people"> | null;
  place(): HostedThreads | null;
  next(request: RpcRequest): Promise<RpcReply>;
}

/** A window's scope is a projection, never the thread's execution owner or the server's authorization. */
export class SpaceRequests {
  constructor(private readonly deps: Dependencies) {}

  async handle(request: RpcRequest, spaceId: string): Promise<RpcReply> {
    try {
      const spaces = this.deps.spaces();
      if (!spaces) throw new Error("OpenOrc accounts aren't available here.");
      const projects = await spaces.projects(spaceId);
      const status = spaces.status();
      const local = projects.flatMap((project) => project.localProjectId ?? []);
      if (status.state === "ready" && status.personalSpaceId === spaceId) local.push(WORKSPACE_ID);
      return { type: "rpc.result", id: request.id, result: await this.answer(request, projects, local) };
    } catch (error) {
      return { type: "rpc.error", id: request.id, message: error instanceof Error ? error.message : String(error) };
    }
  }

  private async answer(request: RpcRequest, projects: SpaceProject[], local: string[]): Promise<unknown> {
    switch (request.method) {
      case "threads.list":
        return this.list(request, rpcParams["threads.list"].parse(request.params), local);
      case "threads.resolvedCount":
        return this.count(request, rpcParams["threads.resolvedCount"].parse(request.params), local);
      case "threads.start":
        return this.start(request, rpcParams["threads.start"].parse(request.params), projects, local);
      case "threads.search": {
        const { spaceId, ...params } = rpcParams["threads.search"].parse(request.params);
        const ids = local.filter((id) => !params.projectId || id === params.projectId);
        const place = this.deps.place();
        // The space's cloud threads are searched where they are kept, as this Mac's are here.
        const cloud = place?.active && place.search ? place.search(spaceId!, params) : Promise.resolve([]);
        const pages = await Promise.all([...ids.map((projectId) => this.read(request, "threads.search", { ...params, projectId })), cloud]);
        return pages
          .flat()
          .sort((a, b) => b.ts - a.ts || a.messageId.localeCompare(b.messageId))
          .slice(0, params.limit ?? 30);
      }
      case "tasks.list": {
        const { spaceId: _space, ...params } = rpcParams["tasks.list"].parse(request.params);
        const ids = local.filter((id) => !params.projectId || id === params.projectId);
        const pages = await Promise.all(ids.map((projectId) => this.read(request, "tasks.list", { ...params, projectId })));
        return [
          ...new Map(
            pages
              .flat()
              .filter((task) => local.includes(task.projectId))
              .map((task) => [task.id, task]),
          ).values(),
        ];
      }
      default:
        throw new Error("This call does not select a space.");
    }
  }

  private async list(request: RpcRequest, params: RpcParams<"threads.list">, local: string[]) {
    const { spaceId: _space, ownership: _ownership, ...legacy } = params;
    const offset = params.offset ?? 0;
    const asked = { ...legacy, offset: 0, ...(params.limit !== undefined && { limit: offset + params.limit }) };
    const projectIds = local.filter((id) => (!params.projectId || id === params.projectId) && (!params.projectIds || params.projectIds.includes(id)));
    const rows = projectIds.length ? await this.read(request, "threads.list", { ...asked, projectIds }) : [];
    const hosted = this.deps.place()?.listed("threads.list", params);
    return mergeThreadPages([{ brain: "mac", reach: "live", heardAt: Date.now(), rows }, ...(hosted ? [{ brain: "hosted" as const, ...hosted }] : [])], asked, "mac").slice(offset);
  }

  private async count(request: RpcRequest, params: RpcParams<"threads.resolvedCount">, local: string[]) {
    const { spaceId: _space, ownership: _ownership, ...legacy } = params;
    const projectIds = local.filter((id) => params.projectIds.includes(id));
    const base = projectIds.length ? await this.read(request, "threads.resolvedCount", { ...legacy, projectIds }) : 0;
    return base + (this.deps.place()?.listed("threads.resolvedCount", params)?.rows ?? 0);
  }

  private async start(request: RpcRequest, params: RpcParams<"threads.start">, projects: SpaceProject[], local: string[]) {
    const place = this.deps.place();
    // A thread under a cloud thread starts on OpenOrc Cloud with it.
    if (params.hosted || (params.parentThreadId && place?.holds({ thread: params.parentThreadId }))) {
      if (!place?.active) throw new Error("Sign in to OpenOrc to start a thread on OpenOrc Cloud.");
      if (!projects.some((project) => project.key === params.projectId && project.hostedProjectId)) throw new Error("This project isn't available in this space.");
      return place.call("threads.start", params);
    }
    if (!local.includes(params.projectId)) throw new Error("This project isn't available in this space.");
    if (params.parentThreadId) {
      const parent = await this.read(request, "threads.get", { id: params.parentThreadId });
      if (!parent || parent.projectId !== params.projectId || !local.includes(parent.projectId)) throw new Error("The parent conversation isn't in this space.");
    }
    const { spaceId: _space, ...legacy } = params;
    return this.read(request, "threads.start", legacy);
  }

  /** The inner routers retain their established request shapes. */
  private async read<M extends RpcMethod>(request: RpcRequest, method: M, params: RpcParams<M>): Promise<RpcResults[M]> {
    const reply = await this.deps.next({ ...request, method, params });
    if (reply.type === "rpc.error") throw new Error(reply.message);
    return reply.result as RpcResults[M];
  }
}
