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
export const HarnessId = z.enum(["codex", "claude", "opencode", "omp", "cursor", "pi", "antigravity", "fx"]);
export type HarnessId = z.infer<typeof HarnessId>;

/** Stable registry order. Onboarding rows, the model list, usage reports and fallbacks all follow it. */
export const harnessIds: readonly HarnessId[] = HarnessId.options;

/** The user's enabled agents, in registry order. Profiles without a choice retain their existing agents. */
export function enabledHarnessIds(settings?: { enabledHarnesses?: readonly HarnessId[] | null }): readonly HarnessId[] {
  const selected = settings?.enabledHarnesses;
  return selected == null ? harnessIds : harnessIds.filter((id) => selected.includes(id));
}

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
  /** Whether the background text runner can generate titles and code explanations with this harness. */
  textGeneration: boolean;
  /** Whether Plan mode hands over its plan document itself; otherwise the agent saves it with OpenOrc's plan_write tool. */
  nativePlans: boolean;
  /** Whether a message can reach the agent during a running turn; otherwise it waits in the queue for the next one. */
  liveInput: boolean;
  /** Whether a new conversation can continue an independent copy of this harness's native session. */
  forks: boolean;
  /** Whether OpenOrc can install, sign in and resume this harness in a cloud workspace. */
  cloud: boolean;
  /**
   * The CLI's npm package, or null for a native-only installation, and its binary on PATH.
   * `prebuilt` is the maker's build service, for a CLI whose npm package needs a runtime the cloud lacks: there it is
   * installed as the maker's own checked binary instead.
   */
  cli: { npm: string | null; bin: string; prebuilt?: string };
}

export const harnessCatalog: Record<HarnessId, HarnessCatalogEntry> = {
  fx: {
    id: "fx",
    name: "fx",
    shortName: "fx",
    account: { id: "fx", label: "fx provider accounts" },
    setupUrl: "https://fx.sh/docs",
    loginCommand: "fx login",
    accountUsageUrl: "https://fx.sh/docs/using-fx/usage-and-costs",
    fastModeHint: "OpenOrc does not expose fx's Fast or Ultra controls yet.",
    distillation: false,
    textGeneration: false,
    nativePlans: false,
    liveInput: true,
    forks: false,
    cloud: false,
    cli: { npm: null, bin: "fx" },
  },
  antigravity: {
    id: "antigravity",
    name: "Antigravity",
    shortName: "Antigravity",
    account: { id: "antigravity", label: "Google Antigravity account" },
    setupUrl: "https://antigravity.google/docs/getting-started?tab=cli",
    loginCommand: "agy acp --login",
    accountUsageUrl: "https://antigravity.google/docs/plans",
    fastModeHint: "Antigravity does not expose a separate Fast mode control.",
    distillation: false,
    textGeneration: false,
    nativePlans: false,
    liveInput: true,
    forks: false,
    cloud: false,
    cli: { npm: null, bin: "agy" },
  },
  pi: {
    id: "pi",
    name: "Pi",
    shortName: "Pi",
    account: { id: "pi", label: "Pi provider accounts" },
    setupUrl: "https://pi.dev",
    loginCommand: "pi",
    accountUsageUrl: "https://pi.dev/docs/providers",
    fastModeHint: "Pi does not expose a separate Fast mode control.",
    distillation: false,
    textGeneration: false,
    nativePlans: false,
    liveInput: true,
    forks: true,
    cloud: false,
    cli: { npm: "@earendil-works/pi-coding-agent", bin: "pi" },
  },
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
    textGeneration: true,
    nativePlans: true,
    liveInput: true,
    forks: true,
    cloud: true,
    cli: { npm: "@openai/codex", bin: "codex" },
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
    textGeneration: true,
    nativePlans: true,
    liveInput: true,
    forks: true,
    cloud: true,
    cli: { npm: "@anthropic-ai/claude-code", bin: "claude" },
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
    textGeneration: true,
    nativePlans: false,
    liveInput: true,
    forks: true,
    cloud: true,
    cli: { npm: "@opencode/cli", bin: "opencode" },
  },
  omp: {
    id: "omp",
    name: "Oh My Pi",
    shortName: "Oh My Pi",
    // Models run through the provider accounts signed into Oh My Pi.
    account: { id: "omp", label: "Oh My Pi provider accounts" },
    setupUrl: "https://omp.sh",
    loginCommand: "omp login",
    accountUsageUrl: "https://omp.sh/docs/providers",
    fastModeHint: "OpenOrc does not expose a separate Fast mode control for Oh My Pi.",
    distillation: false,
    textGeneration: true,
    nativePlans: true,
    liveInput: true,
    forks: true,
    cloud: true,
    // The npm package runs on Bun; the cloud installs the prebuilt binary its installer fetches.
    cli: { npm: "@oh-my-pi/pi-coding-agent", bin: "omp", prebuilt: "https://build.stencil.so/api/products/omp" },
  },
  cursor: {
    id: "cursor",
    name: "Cursor",
    shortName: "Cursor",
    account: { id: "cursor", label: "Cursor account" },
    setupUrl: "https://cursor.com/docs/cli/installation",
    loginCommand: "cursor-agent login",
    accountUsageUrl: "https://cursor.com/dashboard",
    fastModeHint: "Choose a model variant in Cursor's model list. There is no separate Fast mode control.",
    distillation: false,
    textGeneration: false,
    nativePlans: true,
    liveInput: false,
    forks: false,
    cloud: false,
    cli: { npm: null, bin: "cursor-agent" },
  },
};

/** Harnesses the memory extractor can distil with, in registry order. */
export const distillationHarnessIds: readonly HarnessId[] = harnessIds.filter((id) => harnessCatalog[id].distillation);

export const textGenerationHarnessIds: readonly HarnessId[] = harnessIds.filter((id) => harnessCatalog[id].textGeneration);

/** The product name for a run's agent, or the raw id when it is not a harness. */
export const harnessName = (agent: string): string => (isHarnessId(agent) ? harnessCatalog[agent].name : agent);
export const harnessShortName = (agent: string): string => (isHarnessId(agent) ? harnessCatalog[agent].shortName : agent);

/** Shared by the menus and the write boundary, so an unavailable fork never creates a broken thread. */
export function forkUnavailable(agent: string): string | null {
  return isHarnessId(agent) && !harnessCatalog[agent].forks ? `${harnessName(agent)} does not support forking conversations. Start a new conversation instead.` : null;
}

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
export const harnessLoggedIn = (row: Pick<HarnessInfo, "state">): boolean => row.state === "ready";

/** A harness check without where the harness is installed: what a phone hears of it. */
export type HarnessAvailability = Pick<HarnessInfo, "id" | "state">;

/** The checks as `agents.availability` answers them, in registry order. */
export const harnessAvailability = (info: { harnesses: readonly HarnessInfo[] }): HarnessAvailability[] => info.harnesses.map(({ id, state }) => ({ id, state }));
/** Found, but its version command failed, so nothing can run through it until it is reinstalled. */
export const harnessFailsToStart = (row: HarnessInfo): boolean => row.state === "check_failed" && row.path !== null && row.version === null;

/** The probe row for one harness. Every registry harness has a row, so a missing one is a programming error. */
export function harnessInfo(info: { harnesses: readonly HarnessInfo[] }, id: HarnessId): HarnessInfo {
  const row = info.harnesses.find((candidate) => candidate.id === id);
  if (!row) throw new Error(`System info has no row for harness ${id}.`);
  return row;
}
