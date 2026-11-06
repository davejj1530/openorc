import { z } from "zod";
import type { CloudService } from "./cloud.js";
import type { RemoteDevice } from "./remote.js";

/** Where a cloud brain can run, by city: the regions @vercel/sandbox names for sandboxes. */
export const BRAIN_REGIONS = {
  iad1: "Washington, D.C.",
  cle1: "Cleveland",
  yul1: "Montréal",
  sfo1: "San Francisco",
  pdx1: "Portland",
  gru1: "São Paulo",
  lhr1: "London",
  dub1: "Dublin",
  cdg1: "Paris",
  fra1: "Frankfurt",
  arn1: "Stockholm",
  cpt1: "Cape Town",
  bom1: "Mumbai",
  sin1: "Singapore",
  hkg1: "Hong Kong",
  icn1: "Seoul",
  hnd1: "Tokyo",
  kix1: "Osaka",
  syd1: "Sydney",
} as const;
export type BrainRegion = keyof typeof BRAIN_REGIONS;
export const BrainRegion = z.enum(Object.keys(BRAIN_REGIONS) as [BrainRegion, ...BrainRegion[]]);
/** CloudService's schema, here since cloud.ts takes this file's params: importing its value back would be a cycle. */
const BrainService: z.ZodType<CloudService> = z.enum(["vercel", "agent37"]);

/** Time zones nearer a region than their area's default, mostly cities with a region of their own. */
const CITIES: Record<string, BrainRegion> = {
  "America/Toronto": "yul1",
  "America/Montreal": "yul1",
  "Europe/London": "lhr1",
  "Europe/Dublin": "dub1",
  "Europe/Paris": "cdg1",
  "Europe/Stockholm": "arn1",
  "Africa/Johannesburg": "cpt1",
  "Asia/Kolkata": "bom1",
  "Asia/Calcutta": "bom1",
  "Asia/Karachi": "bom1",
  "Asia/Dubai": "bom1",
  "Asia/Muscat": "bom1",
  "Asia/Qatar": "bom1",
  "Asia/Bahrain": "bom1",
  "Asia/Riyadh": "bom1",
  "Asia/Kuwait": "bom1",
  "Asia/Hong_Kong": "hkg1",
  "Asia/Macau": "hkg1",
  "Asia/Shanghai": "hkg1",
  "Asia/Taipei": "hkg1",
  "Asia/Seoul": "icn1",
  "Asia/Tokyo": "hnd1",
};
/** South America, nearer São Paulo than Washington. */
const SOUTH =
  /^America\/(Argentina\/\w+|Sao_Paulo|Santiago|Punta_Arenas|Montevideo|Asuncion|La_Paz|Lima|Bogota|Guayaquil|Caracas|Belem|Fortaleza|Recife|Bahia|Maceio|Manaus|Cuiaba|Campo_Grande|Porto_Velho|Paramaribo|Cayenne|Guyana)$/;
/** The American west, nearer San Francisco than Washington. */
const WEST = /^(America\/(Los_Angeles|Vancouver|Tijuana|Whitehorse|Dawson|Phoenix|Denver|Boise|Edmonton|Anchorage|Juneau|Sitka|Nome)|Pacific\/Honolulu|US\/(Pacific|Mountain|Arizona|Alaska|Hawaii))$/;
const AREAS: Record<string, BrainRegion> = {
  America: "iad1",
  US: "iad1",
  Canada: "iad1",
  Europe: "fra1",
  Africa: "fra1",
  Atlantic: "fra1",
  Asia: "sin1",
  Indian: "sin1",
  Australia: "syd1",
  Pacific: "syd1",
};

/** The region the picker starts on: the nearest one by the Mac's time zone, as an IANA name. */
export function brainRegionFor(timeZone: string): BrainRegion {
  if (WEST.test(timeZone)) return "sfo1";
  if (SOUTH.test(timeZone)) return "gru1";
  return CITIES[timeZone] ?? AREAS[timeZone.split("/")[0] ?? ""] ?? "iad1";
}

/** What setting a brain up is doing: making its machine and installing it, starting it, sending it the sign-ins. */
export type CloudBrainStep = "machine" | "start" | "sign-ins";

/** The brain's machine as its service reports it. */
export type CloudBrainMachine = "awake" | "asleep" | "starting" | "stopping" | "failed";

/**
 * The door a paired phone knocks on to wake a brain on Vercel, a small function in the same team that this Mac deploys
 * and keeps current. `failed` keeps the reason a phone cannot wake the brain by itself. A brain on Agent37 has none: any
 * request to its address wakes it.
 */
export type CloudBrainDoor = { state: "open" } | { state: "opening" } | { state: "failed"; error: string };

/** Where a brain lives: its service, and its region on Vercel. Agent37 runs its default instances in one region, so null there. */
export interface CloudBrainPlace {
  service: CloudService;
  region: BrainRegion | null;
}

/**
 * Moving a brain to the other service: its threads come to this Mac, a new brain is set up there, the old one is
 * removed, and the threads go to the new one.
 */
export type CloudBrainMoveStep = "home" | "setting-up" | "removing" | "back";

/** What setting up the new brain is doing, its project copies last. */
export type CloudBrainMoveSetup = CloudBrainStep | "projects";

/** What Settings shows about the cloud brain. Its key and the tokens sent to it never leave the core. */
export type CloudBrainStatus =
  /** This build carries no brain to set up. */
  | { state: "unavailable" }
  | { state: "none"; error: string | null }
  /** The Vercel team or Agent37 account has a brain this Mac has no key for. */
  | { state: "elsewhere"; service: CloudService; error: string | null }
  | ({ state: "setting-up"; step: CloudBrainStep } & CloudBrainPlace)
  /** Setup stopped before the brain first started, or its machine is gone. Setting up again keeps its key and place. */
  | ({ state: "incomplete"; error: string | null } & CloudBrainPlace)
  | ({
      state: "ready";
      /** Null while its service cannot be asked. */
      machine: CloudBrainMachine | null;
      /** The Claude accounts it signs in as, by name, as last sent. */
      claude: string[];
      /** The Claude sign-ins changed on this Mac since they were last sent. */
      behind: boolean;
      /** Updating: installing this build's brain, or restarting it onto the one installed. */
      working: "waking" | "sending" | "updating" | null;
      /** Null until this Mac has looked at it since it started, and in builds without one. */
      door: CloudBrainDoor | null;
      /** The conversations on it, as it last counted them for this Mac. They go with it when it is removed. */
      threads: number;
      /** It moved here from the other service, and no phone has paired with it since. Absent unless it moved. */
      pairAgain?: boolean;
      /** What the last move left to say: why it did not happen, or which threads stayed on this Mac. Kept until dismissed. */
      note?: string;
      error: string | null;
    } & CloudBrainPlace)
  /**
   * Moving to `to`, where it runs from the swap on: the place is where it runs now. A move that stopped on a failure it
   * can go on from keeps its step and says why.
   */
  | ({
      state: "moving";
      to: CloudBrainPlace;
      step: CloudBrainMoveStep;
      /** The threads moved in this step so far, of how many; null in the step that moves none. */
      threads: { done: number; of: number } | null;
      /** While setting up the new brain, the part under way. */
      setup: CloudBrainMoveSetup | null;
      /** Why it stopped; null while it runs. */
      error: string | null;
    } & CloudBrainPlace)
  | { state: "removing" };

/** A project on this Mac, and whether the cloud brain has a copy of it. */
/** What the brain and its thread machines ran since `since` (the month's start), by its service's numbers. */
export interface CloudBrainCost {
  usd: number;
  since: number;
}

export interface CloudBrainProject {
  /** The Mac project. */
  id: string;
  name: string;
  /** Switched on: the brain has, or is getting, a copy of its default branch, kept fresh whenever the Mac wakes it. */
  on: boolean;
  /** Why it cannot be switched now; null when it can. */
  blocked: string | null;
  /** Its copy is on its way to the brain. */
  sending: boolean;
  /** The brain's copy has commits on the default branch this Mac lacks, so it kept them instead of this Mac's. */
  kept: boolean;
  /** Why the last send failed. */
  error: string | null;
  /** The branch its copy follows, as the brain last took it; null while it has none. */
  branch: string | null;
}

/** What a copy of a project takes when it is added: the branch it follows, and the commit that branch is on now. */
export interface CloudBrainCopy {
  branch: string;
  /** Short. */
  commit: string;
  subject: string;
  /** The branch this Mac's folder has checked out, when it is another, whose work stays here. */
  checkedOut: string | null;
}

/** What the brain signs in with besides Claude, as this Mac last handed it over; `behind` while this Mac's changed since. */
export interface CloudBrainSignIns {
  /** The brain's own Codex login, made from this Mac and never a copy of its own. */
  codex: {
    mode: "chatgpt" | "apiKey" | null;
    email: string | null;
    plan: string | null;
    /** The browser sign-in for the brain is open. */
    signingIn: boolean;
    /** A login made for the brain, or its sign-out, that the brain has not taken yet. */
    pending: { mode: "chatgpt" | "apiKey"; email: string | null; plan: string | null } | "sign-out" | null;
    /** Why the last browser sign-in did not finish. */
    error: string | null;
  };
  /**
   * This Mac's GitHub sign-in, for the brain's own pushes and pull requests. Off unless switched on. `blocked`: why it
   * cannot be switched on, or why nothing was sent while it is on.
   */
  github: { on: boolean; blocked: string | null; behind: boolean };
  /** This Mac's push key, which the brain sends phone alerts with. */
  push: { has: boolean; behind: boolean };
  /** This Mac's memory's Anthropic API key, which the brain's memory distils with while the Mac's does. */
  memory: { has: boolean; behind: boolean };
  /** The user's own skills chosen for cloud sessions, which the brain's sandboxes get too. Absent from an older core. */
  skills?: { has: boolean; behind: boolean };
  /** The projects' cloud environments, which the brain's threads in their copies get. Absent from an older core. */
  env?: { has: boolean; behind: boolean };
}

export interface CloudBrainPairing {
  /** `openorc://pair#…`, drawn as a QR code. Holds a one-time secret. */
  url: string;
  expiresAt: number;
}

/** Desktop-only, like the rest of cloud.*: a phone cannot set up, wake or remove the brain. */
export const cloudBrainRpcParams = {
  "cloud.brain.status": z.object({}),
  /**
   * Makes the brain on the service, the one new cloud threads run on unless given, on Vercel in the region, and sets it
   * up in the background. Again after a failure, with the key and place it has.
   */
  "cloud.brain.create": z.object({ region: BrainRegion.optional(), service: BrainService.optional() }).strict(),
  /**
   * Moves a ready brain to the other service, on Vercel in the region, in the background: its threads come to this Mac,
   * a new brain is set up there with a new key, the old one is removed, and the threads go back. Again on a move that
   * stopped, it goes on from where it stopped.
   */
  "cloud.brain.move": z.object({ to: BrainService, region: BrainRegion.optional() }).strict(),
  /** Calls off a move that stopped: before the old brain went, the new one goes; after the swap, threads not yet back stay on this Mac. */
  "cloud.brain.move.cancel": z.object({}),
  /** Forgets what the last move left to say. */
  "cloud.brain.move.dismiss": z.object({}),
  /** Starts the brain unless it runs, and sends sign-ins that changed. */
  "cloud.brain.wake": z.object({}),
  /** Wakes the brain and asks it for a phone pairing code. */
  "cloud.brain.pair": z.object({}),
  /** Sends the sign-ins again, waking the brain. */
  "cloud.brain.handover": z.object({}),
  /** Deletes a Vercel brain's door, then the brain with its disk and its thread machines, and forgets its key. */
  "cloud.brain.remove": z.object({}),
  /** Has the brain count its conversations again, for the Remove confirm. Never wakes it: one asleep keeps its last count. */
  "cloud.brain.recount": z.object({}),
  /** This Mac's projects, and which the brain has. Never wakes the brain. */
  "cloud.brain.projects": z.object({}),
  /** What the brain and its thread machines cost this month, from its service's own numbers; null before setup. Never wakes it. */
  "cloud.brain.cost": z.object({}),
  /**
   * What keeps the brain awake, as it says, such as "phones"; null when nothing does and it sleeps once idle, and while it
   * sleeps or cannot be asked. Never wakes it, and asking is not use.
   */
  "cloud.brain.busy": z.object({}),
  /** Sends a project to the brain, or removes its copy there, waking the brain. */
  "cloud.brain.project": z.object({ projectId: z.string().min(1), on: z.boolean() }).strict(),
  /** What the brain signs in with besides Claude. Never wakes the brain. */
  "cloud.brain.signIns": z.object({}),
  /** Opens the browser to sign in to Codex for the brain alone; the login goes to the brain and this Mac keeps none. */
  "cloud.brain.codex.signIn": z.object({}),
  "cloud.brain.codex.cancel": z.object({}),
  "cloud.brain.codex.apiKey": z.object({ key: z.string().trim().min(8).max(1000) }).strict(),
  /** Signs the brain out of Codex. */
  "cloud.brain.codex.remove": z.object({}),
  /** Sends this Mac's GitHub sign-in to the brain, or deletes it there, waking the brain. */
  "cloud.brain.github": z.object({ on: z.boolean() }).strict(),
  /** The phones paired with the brain, as this Mac last heard them. Never wakes the brain. */
  "cloud.brain.phones": z.object({}),
  /** Unpairs a phone from the brain, waking it, so the phone can no longer connect. */
  "cloud.brain.phones.remove": z.object({ id: z.string().min(1).max(100) }).strict(),
};

export interface CloudBrainRpcResults {
  "cloud.brain.status": CloudBrainStatus;
  "cloud.brain.create": CloudBrainStatus;
  "cloud.brain.move": CloudBrainStatus;
  "cloud.brain.move.cancel": CloudBrainStatus;
  "cloud.brain.move.dismiss": CloudBrainStatus;
  "cloud.brain.wake": CloudBrainStatus;
  "cloud.brain.pair": CloudBrainPairing;
  "cloud.brain.handover": CloudBrainStatus;
  "cloud.brain.remove": CloudBrainStatus;
  "cloud.brain.recount": CloudBrainStatus;
  "cloud.brain.projects": CloudBrainProject[];
  "cloud.brain.cost": CloudBrainCost | null;
  "cloud.brain.busy": string | null;
  "cloud.brain.project": CloudBrainProject[];
  "cloud.brain.signIns": CloudBrainSignIns;
  "cloud.brain.codex.signIn": CloudBrainSignIns;
  "cloud.brain.codex.cancel": CloudBrainSignIns;
  "cloud.brain.codex.apiKey": CloudBrainSignIns;
  "cloud.brain.codex.remove": CloudBrainSignIns;
  "cloud.brain.github": CloudBrainSignIns;
  "cloud.brain.phones": RemoteDevice[];
  "cloud.brain.phones.remove": RemoteDevice[];
}
