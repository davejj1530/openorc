import { z } from "zod";

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

/** The brain's sandbox as Vercel reports it. */
export type CloudBrainMachine = "awake" | "asleep" | "starting" | "stopping" | "failed";

/** What Settings shows about the cloud brain. Its key and the tokens sent to it never leave the core. */
export type CloudBrainStatus =
  /** This build carries no brain to set up. */
  | { state: "unavailable" }
  | { state: "none"; error: string | null }
  /** The Vercel team has a brain this Mac has no key for. */
  | { state: "elsewhere"; error: string | null }
  | { state: "setting-up"; region: BrainRegion; step: CloudBrainStep }
  /** Setup stopped before the brain first started, or its machine is gone. Setting up again keeps its key and region. */
  | { state: "incomplete"; region: BrainRegion; error: string | null }
  | {
      state: "ready";
      region: BrainRegion;
      /** Null while Vercel cannot be asked. */
      machine: CloudBrainMachine | null;
      /** The Claude accounts it signs in as, by name, as last sent. */
      claude: string[];
      /** The Claude sign-ins changed on this Mac since they were last sent. */
      behind: boolean;
      working: "waking" | "sending" | null;
      error: string | null;
    }
  | { state: "removing" };

export interface CloudBrainPairing {
  /** `openorc://pair#…`, drawn as a QR code. Holds a one-time secret. */
  url: string;
  expiresAt: number;
}

/** Desktop-only, like the rest of cloud.*: a phone cannot set up, wake or remove the brain. */
export const cloudBrainRpcParams = {
  "cloud.brain.status": z.object({}),
  /** Makes the brain in the region and sets it up in the background. Again after a failure, with the key and region it has. */
  "cloud.brain.create": z.object({ region: BrainRegion }).strict(),
  /** Starts the brain unless it runs, and sends Claude sign-ins that changed. */
  "cloud.brain.wake": z.object({}),
  /** Wakes the brain and asks it for a phone pairing code. */
  "cloud.brain.pair": z.object({}),
  /** Sends the Claude sign-ins again, waking the brain. */
  "cloud.brain.handover": z.object({}),
  /** Deletes the brain with its disk and its thread sandboxes, and forgets its key. */
  "cloud.brain.remove": z.object({}),
};

export interface CloudBrainRpcResults {
  "cloud.brain.status": CloudBrainStatus;
  "cloud.brain.create": CloudBrainStatus;
  "cloud.brain.wake": CloudBrainStatus;
  "cloud.brain.pair": CloudBrainPairing;
  "cloud.brain.handover": CloudBrainStatus;
  "cloud.brain.remove": CloudBrainStatus;
}
