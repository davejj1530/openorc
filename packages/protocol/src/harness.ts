import { z } from "zod";

/**
 * The coding harnesses the app can drive. A harness is the process that runs
 * the agent loop (Claude Code, Codex); which account bills its tokens is a
 * separate matter carried by `ModelOption.provider`.
 *
 * Adding a harness starts here. The id joins this enum, TypeScript then asks
 * for its catalog entry below, its shell probes in the core registry and its
 * run adapter. Nothing else in the app should name a harness by string.
 */
export const HarnessId = z.enum(["codex", "claude", "opencode"]);
export type HarnessId = z.infer<typeof HarnessId>;

/** Stable registry order. Onboarding rows, the model list, usage reports and fallbacks all follow it. */
export const harnessIds: readonly HarnessId[] = HarnessId.options;

export const isHarnessId = (value: unknown): value is HarnessId => typeof value === "string" && (harnessIds as readonly string[]).includes(value);

/** The harness a run falls back to when nothing chose one: the first in registry order. */
export const defaultHarnessId: HarnessId = harnessIds[0]!;

/** The environment variable that carries the harness binary the login shell resolved. */
export const harnessBinaryVariable = (id: HarnessId): string => `OPENORC_${id.toUpperCase()}_BIN`;

/** What the app says and links about a harness. Static, so the renderer can draw rows before any probe answers. */
export interface HarnessCatalogEntry {
  id: HarnessId;
  /** The product name, for labels and messages. */
  name: string;
  /** How the agent is addressed in a sentence, as in "Message Claude". */
  shortName: string;
  /** The billing account behind the harness's own models. */
  account: { id: string; label: string };
  /** Install and sign-in instructions. */
  setupUrl: string;
  /** The terminal command that signs the harness in. */
  loginCommand: string;
  /** Where the account's allowance is shown. */
  accountUsageUrl: string;
  /** What Fast mode costs on this harness, shown beside the toggle. */
  fastModeHint: string;
  /** Whether the memory extractor can drive this harness for one-shot distillation prompts. */
  distillation: boolean;
  /** Whether Plan mode hands over its plan document itself; otherwise the agent saves it with OpenOrc's plan_write tool. */
  nativePlans: boolean;
  /** Whether a message can reach the agent during a running turn; otherwise it waits in the queue for the next one. */
  liveInput: boolean;
}

export const harnessCatalog: Record<HarnessId, HarnessCatalogEntry> = {
  codex: {
    id: "codex",
    name: "Codex",
    shortName: "Codex",
    account: { id: "codex", label: "ChatGPT account" },
    setupUrl: "https://developers.openai.com/codex/cli",
    loginCommand: "codex login",
    accountUsageUrl: "https://chatgpt.com/codex/settings/usage",
    fastModeHint: "Higher credit usage · subject to account availability.",
    distillation: true,
    nativePlans: true,
    liveInput: true,
  },
  claude: {
    id: "claude",
    name: "Claude Code",
    shortName: "Claude",
    account: { id: "claude", label: "Claude account" },
    setupUrl: "https://code.claude.com/docs/en/setup",
    loginCommand: "claude auth login",
    accountUsageUrl: "https://claude.ai/settings/usage",
    fastModeHint: "Higher cost · requires paid usage credits and account access.",
    distillation: true,
    nativePlans: true,
    liveInput: true,
  },
  opencode: {
    id: "opencode",
    name: "OpenCode",
    shortName: "OpenCode",
    // OpenCode runs models through whichever provider accounts the user signed into it; each bills separately.
    account: { id: "opencode", label: "OpenCode provider accounts" },
    setupUrl: "https://opencode.ai/docs/",
    loginCommand: "opencode auth login",
    accountUsageUrl: "https://opencode.ai/docs/providers/",
    fastModeHint: "OpenOrc does not expose a separate Fast mode control for OpenCode.",
    distillation: false,
    nativePlans: false,
    liveInput: false,
  },
};

/** Harnesses the memory extractor can distil with, in registry order. */
export const distillationHarnessIds: readonly HarnessId[] = harnessIds.filter((id) => harnessCatalog[id].distillation);

/** The product name for a run's agent, or the raw id when it is not a harness. */
export const harnessName = (agent: string): string => (isHarnessId(agent) ? harnessCatalog[agent].name : agent);
export const harnessShortName = (agent: string): string => (isHarnessId(agent) ? harnessCatalog[agent].shortName : agent);

/** "Codex or Claude Code", for messages that name several harnesses; every harness unless told which. */
export const harnessNameList = (ids: readonly HarnessId[] = harnessIds): string => ids.map((id) => harnessCatalog[id].name).join(" or ");

export type HarnessState = "ready" | "sign_in" | "not_found" | "check_failed";

/** One completed harness check. `checking` is renderer state while this result is pending. */
export interface HarnessInfo {
  id: HarnessId;
  state: HarnessState;
  path: string | null;
  version: string | null;
  /** The immutable shell-environment revision used for every field above. */
  revision: number;
}

export const harnessInstalled = (row: HarnessInfo): boolean => row.path !== null && row.state !== "not_found";
export const harnessLoggedIn = (row: HarnessInfo): boolean => row.state === "ready";

/** The probe row for one harness. Every registry harness has a row, so a missing one is a programming error. */
export function harnessInfo(info: { harnesses: readonly HarnessInfo[] }, id: HarnessId): HarnessInfo {
  const row = info.harnesses.find((candidate) => candidate.id === id);
  if (!row) throw new Error(`System info has no row for harness ${id}.`);
  return row;
}
