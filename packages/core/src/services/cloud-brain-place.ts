import { createHash } from "node:crypto";
import type { Agent37Connection, BrainAccess, HandoverValues, WakeInput } from "@openorc/cloud";
import type { BrainRegion, CloudService } from "@openorc/protocol";

/**
 * Where a brain lives, as this Mac keeps it: a Vercel team and region, or the Agent37 account by accountOf. Records from
 * before Agent37 lack `service`, and Agent37 records from before the account was kept lack `account`.
 */
export type BrainPlace = { service?: "vercel"; teamId: string; region: BrainRegion } | { service: "agent37"; account?: string };

/** The connections a brain is reached with, as Settings has them now. */
export interface BrainConnections {
  vercel: () => Promise<{ token: string; teamId: string; vcpus?: number; region?: string } | null>;
  agent37: () => Promise<Agent37Connection | null>;
  /** The service a new brain is made on. */
  service: () => Promise<CloudService | null>;
}

/** The connections given, a brain made on Vercel while it is connected unless the service is given too. */
export function brainConnections(given: Pick<BrainConnections, "vercel"> & Partial<BrainConnections>): BrainConnections {
  const { vercel } = given;
  return { vercel, agent37: given.agent37 ?? (async () => null), service: given.service ?? (async () => ((await vercel()) ? "vercel" : null)) };
}

export const SERVICE_NAMES: Record<CloudService, string> = { vercel: "Vercel", agent37: "Agent37" };

export const serviceOf = (place: BrainPlace): CloudService => place.service ?? "vercel";

/** Agent37 has one region for its default instances, so a brain there has none to show. */
export const regionOf = (place: BrainPlace): BrainRegion | null => (place.service === "agent37" ? null : place.region);

/** One per account: a Vercel team, an Agent37 key by its digest, so the key itself is never kept for a comparison. */
export const accountOf = (access: BrainAccess): string => (access.service === "agent37" ? `agent37\n${createHash("sha256").update(access.key).digest("hex")}` : `vercel\n${access.teamId}`);

/** How the brain at `place` is reached now; null while its service is not connected, or Agent37 is with another account's key. */
export async function accessAt(place: BrainPlace, connections: BrainConnections): Promise<BrainAccess | null> {
  if (place.service === "agent37") {
    const agent37 = await connections.agent37();
    const access = agent37 && ({ service: "agent37", key: agent37.key } as const);
    return access && (!place.account || accountOf(access) === place.account) ? access : null;
  }
  const vercel = await connections.vercel();
  return vercel && { service: "vercel", token: vercel.token, teamId: place.teamId };
}

/** Which connection the brain at `place` waits for, in words. */
async function connectFirst(place: BrainPlace, connections: BrainConnections): Promise<string> {
  if (place.service !== "agent37") return "Connect Vercel and choose a team first.";
  return (await connections.agent37()) ? "The cloud brain is on another Agent37 account. Connect that account's key." : "Connect Agent37 first.";
}

/** As accessAt, but says in words which service to connect. */
export async function reach(place: BrainPlace, connections: BrainConnections): Promise<BrainAccess> {
  const access = await accessAt(place, connections);
  if (!access) throw new Error(await connectFirst(place, connections));
  return access;
}

/**
 * How a brain set up now is reached: on `service`, else the one new cloud machines run on, in the Vercel team Settings
 * chose. Null while it is not connected.
 */
export async function accessHere(connections: BrainConnections, service?: CloudService): Promise<BrainAccess | null> {
  if ((service ?? (await connections.service())) === "agent37") return accessAt({ service: "agent37" }, connections);
  const vercel = await connections.vercel();
  return vercel && { service: "vercel", token: vercel.token, teamId: vercel.teamId };
}

/** Where a brain set up now, reached with `access`, lives. */
export function placeOf(access: BrainAccess, region: BrainRegion | undefined): BrainPlace {
  if (access.service === "agent37") return { service: "agent37", account: accountOf(access) };
  if (!region) throw new Error("Choose a region for the cloud brain.");
  return { service: "vercel", teamId: access.teamId, region };
}

/** The size of the thread machines the brain makes, from Settings now. */
export async function threadSizes(place: BrainPlace, connections: BrainConnections): Promise<Pick<WakeInput, "threadVcpus" | "threadSize">> {
  if (place.service === "agent37") {
    const agent37 = await connections.agent37();
    return agent37 ? { threadSize: { cpu: agent37.cpu, memory: agent37.memory } } : {};
  }
  const vcpus = (await connections.vercel())?.vcpus;
  return vcpus ? { threadVcpus: vcpus } : {};
}

/**
 * Where the brain's new threads run, from Settings now: the service "Run on" names, and each connection. A brain on
 * Vercel keeps its thread sandboxes on its own team; one on Agent37 uses the team Settings chose. Null with none connected.
 */
export async function threadCloud(place: BrainPlace, connections: BrainConnections): Promise<HandoverValues["cloud"] | null> {
  const service = await connections.service();
  if (!service) return null;
  const vercel = await connections.vercel();
  const { token, teamId, vcpus, region } = vercel ?? {};
  const team = place.service === "agent37" ? teamId : place.teamId;
  return {
    service,
    agent37: await connections.agent37(),
    vercel: token && team ? { token, teamId: team, ...(vcpus ? { vcpus } : {}), ...(region ? { region } : {}) } : null,
  };
}

/** The region a provision makes the machine in, where its service has regions. */
export function provisionAt(place: BrainPlace): { region?: string } {
  const region = regionOf(place);
  return region ? { region } : {};
}

/**
 * A brain found where one was to be set up, which this Mac has no key for. Shown, and removable, while it is still there
 * on the account of its service as Settings connects it now.
 */
export class BrainElsewhere {
  private found: { service: CloudService; account: string } | null = null;

  constructor(
    private readonly connections: BrainConnections,
    private readonly open: (access: BrainAccess) => Promise<{ status(): Promise<{ state: string }> } | null>,
  ) {}

  /** The service it was found on, which removing it goes to. */
  get service(): CloudService | undefined {
    return this.found?.service;
  }

  saw(access: BrainAccess): void {
    this.found = { service: access.service, account: accountOf(access) };
  }

  forget(): void {
    this.found = null;
  }

  /** Its service while it is still there. */
  async still(): Promise<CloudService | null> {
    const found = this.found;
    if (!found) return null;
    try {
      const access = await accessHere(this.connections, found.service);
      const machine = access && accountOf(access) === found.account ? await this.open(access) : null;
      if (!machine || (await machine.status()).state === "missing") this.found = null;
    } catch {
      // Its service could not be asked: what was found stays until it can.
    }
    return this.found?.service ?? null;
  }
}
