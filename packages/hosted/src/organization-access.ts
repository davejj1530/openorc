import type { RpcParams, RpcResults } from "@openorc/protocol";
import type { HostedDeps } from "./index.js";
import { Refused, type Session } from "./session.js";
import { ROUTES } from "./wire.js";

interface Dependencies extends Pick<HostedDeps, "push"> {
  session: Session;
  refresh(): Promise<void>;
}

export class OrganizationAccess {
  constructor(private readonly deps: Dependencies) {}

  async get({ spaceId, projectId }: RpcParams<"organization.project.access">): Promise<RpcResults["organization.project.access"]> {
    const generation = this.deps.session.generation;
    const reply = await this.deps.session.in(spaceId).request(ROUTES.projectAccess(projectId));
    this.#assert(generation);
    return reply;
  }

  async set({ spaceId, projectId, everyone, memberIds }: RpcParams<"organization.project.setAccess">): Promise<RpcResults["organization.project.setAccess"]> {
    const generation = this.deps.session.generation;
    try {
      const reply = await this.deps.session.in(spaceId).request(ROUTES.setProjectAccess(projectId), { everyone, memberIds });
      this.#assert(generation);
      return reply;
    } finally {
      if (generation === this.deps.session.generation) {
        await this.deps.refresh();
        this.#assert(generation);
        this.deps.push({ type: "invalidate", keys: ["spaces", "projects", "threads", `access:${spaceId}:${projectId}`] });
      }
    }
  }

  #assert(generation: number): void {
    if (!this.deps.session.state.signedIn || this.deps.session.generation !== generation) throw new Refused("Your OpenOrc session changed. Try again.");
  }
}
