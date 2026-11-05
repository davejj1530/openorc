import type { Db } from "@openorc/db";
import { fromBase64Url, linkUrl } from "@openorc/link";
import { nodeCrypto } from "@openorc/link/node";
import type { CloudService, RpcRequest } from "@openorc/protocol";
import type { Logger, RpcReply, Transport } from "../transport.js";
import { BrainLink, type BrainEndpoint, type ProjectMapping } from "./brain-link.js";
import { BrainMirrors } from "./brain-mirrors.js";
import { BrainRouter } from "./brain-router.js";
import { BrainSync, type BrainSyncDeps } from "./brain-sync.js";
import type { CloudBrain } from "./cloud-brain.js";
import { ownerLinkKeys } from "./owner-link.js";

/** The brain's link key, learned once from the brain itself while it runs; asking never wakes it. */
async function linkKeyOf(brain: CloudBrain, known: string | null): Promise<string | null> {
  if (known) return known;
  const asked = await brain.withMachine(false, (machine) => machine.control({ op: "identity" })).catch(() => null);
  if (asked) await brain.rememberLinkKey(asked.linkKey);
  return asked?.linkKey ?? null;
}

/** The Mac's own cloud brain as its owner link dials it: the address and keys CloudBrain keeps; a wake as Wake does. */
function cloudBrainEndpoint(brain: CloudBrain): BrainEndpoint {
  return {
    ready: async () => (await brain.moves()) !== null,
    projects: () => projectMapping(brain),
    locate: async () => {
      const target = await brain.moves();
      const linkKey = target && (await linkKeyOf(brain, target.linkKey));
      if (!target || !linkKey) return null;
      const brainKey = fromBase64Url(linkKey);
      return { url: linkUrl({ kind: "public", host: target.address, port: 443 }, brainKey, nodeCrypto), brainKey, ownerKeys: ownerLinkKeys(target.key) };
    },
    dialable: () => brain.dialable(),
    wake: () => brain.withMachine(true, async () => undefined),
    freshen: () => brain.freshenProjects(),
  };
}

/** How often, while the brain is awake, this Mac looks whether a chosen project's branch moved. */
const FRESHEN_MS = 2 * 60_000;

async function projectMapping(brain: CloudBrain): Promise<ProjectMapping> {
  const copies = ((await brain.moves())?.projects ?? []).filter((record) => record.brainId);
  return {
    toCloud: (macProject) => copies.find((record) => record.id === macProject)?.brainId ?? null,
    toMac: (cloudProject) => copies.find((record) => record.brainId === cloudProject)?.id ?? null,
    pairs: copies.map((record) => ({ mac: record.id, cloud: record.brainId! })),
  };
}

/**
 * Whether this Mac's windows reach a cloud brain at all. A Mac without one routes nothing and dials nothing; with one,
 * the router serves its windows and the link keeps the brain's lists fresh. Followed as the brain is set up or removed.
 */
export class BrainRouting {
  active = false;
  readonly link: BrainLink;
  readonly router: BrainRouter;

  constructor(deps: {
    db: Db;
    dataDir: string;
    brain: CloudBrain;
    windows: Transport;
    local(request: RpcRequest): Promise<RpcReply>;
    notificationsOn(): boolean;
    log: Logger;
    memory: BrainSyncDeps["memory"];
    textGeneration: BrainSyncDeps["textGeneration"];
    /** The service the brain's new threads run on, as Settings says. */
    service(): Promise<CloudService | null>;
    endpoint?: BrainEndpoint;
  }) {
    const { db, brain, windows, local, notificationsOn, log } = deps;
    const endpoint = deps.endpoint ?? cloudBrainEndpoint(brain);
    this.ready = () => endpoint.ready();
    this.link = new BrainLink({ endpoint, log });
    this.mirrors = new BrainMirrors({
      db,
      dataDir: deps.dataDir,
      snapshot: (threadId, known) => this.link.call("threads.snapshot", { threadId, known }, { wake: true }),
      thread: async (id) => {
        const thread = await this.link.call("threads.get", { id }, { wake: true });
        if (!thread) throw new Error("That conversation is not in the cloud.");
        return thread;
      },
      mapping: () => endpoint.projects(),
      changed: (id) => windows.push({ type: "invalidate", keys: ["threads", `thread:${id}`, "files", "workspace-diff"] }),
      log,
    });
    this.router = new BrainRouter({
      db,
      link: this.link,
      mirrors: this.mirrors,
      local,
      windows,
      mapping: () => endpoint.projects(),
      wake: () => endpoint.wake(),
      updating: () => brain.installingUpdate,
      service: deps.service,
      notificationsOn,
      log,
    });
    this.endpoint = endpoint;
    this.windows = windows;
    this.log = log;
    this.sync = new BrainSync({
      db,
      memory: deps.memory,
      textGeneration: deps.textGeneration,
      call: (method, params) => this.link.call(method, params, { wake: false }),
      mapping: () => endpoint.projects(),
      log,
    });
    this.link.onReach((reach) => {
      if (reach !== "live") return;
      this.sync.relinked();
      void this.freshen();
    });
    this.link.onPush((push) => {
      if (push.type === "push" && push.push.type === "invalidate" && push.push.keys.some((key) => key.startsWith("memory"))) this.sync.brainTouched();
    });
  }

  private readonly sync: BrainSync;

  private readonly endpoint: BrainEndpoint;
  private readonly windows: Transport;
  private readonly log: Logger;
  private freshening: ReturnType<typeof setInterval> | null = null;

  /**
   * The brain's copies follow this Mac's branches while both are awake, and the two exchange memory and the Mac's open
   * tasks: when the brain answers, now and then after, and once more as this Mac goes to sleep. Never wakes the brain.
   */
  async freshen(): Promise<void> {
    if (!this.active || this.link.reach !== "live") return;
    await this.endpoint.freshen?.().catch((error: unknown) => this.log.warn(`the cloud brain's project copies did not refresh: ${error instanceof Error ? error.message : String(error)}`));
    await this.sync.exchange();
  }

  readonly mirrors: BrainMirrors;

  private readonly ready: () => Promise<boolean>;

  /** At start and whenever the cloud brain changed: routing follows whether one is set up; a wake may let the link dial. */
  async refresh(): Promise<void> {
    const ready = await this.ready();
    if (ready && !this.active) {
      this.link.start();
      this.freshening = setInterval(() => void this.freshen(), FRESHEN_MS);
      this.freshening.unref();
    }
    if (!ready && this.active) {
      this.link.close();
      this.router.pages.clear();
      this.stopFreshening();
    }
    this.active = ready;
    if (ready) this.link.awoke();
    this.router.starts.brainChanged();
  }

  /** The brain was removed: its kept lists and this Mac's read-only copies of its threads go, and windows read again. */
  async forget(): Promise<void> {
    this.router.pages.clear();
    await this.mirrors.closeAll();
    this.windows.push({ type: "invalidate", keys: ["threads"] });
  }

  private stopFreshening(): void {
    if (this.freshening) clearInterval(this.freshening);
    this.freshening = null;
  }

  close(): void {
    this.stopFreshening();
    this.link.close();
    this.router.close();
  }
}
