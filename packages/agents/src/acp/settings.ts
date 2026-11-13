import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { RunSpec } from "@openorc/protocol";
import type { AcpProfile } from "./profile.js";
import type { LiveSettings } from "../run-handle.js";
import { withSettingsRollback } from "../live-settings.js";

type Options = SessionConfigOption[] | null | undefined;

/** The last acknowledged selection, including provider and model-dependent effort options. */
export class AcpSettings {
  private options: Options;
  busy = false;

  get model(): string | null {
    return selectedModel(this.options, this.profile);
  }

  constructor(
    private readonly profile: AcpProfile,
    private readonly write: (id: string, value: string) => Promise<Options>,
    private readonly close: () => void,
  ) {}

  async initialize(options: Options, spec: RunSpec): Promise<Options> {
    this.options = options;
    await initialSettings(options, spec, this.profile, (id, value) => this.set(id, value));
    return this.options;
  }

  async apply({ model, effort, fastMode }: LiveSettings): Promise<void> {
    if (this.busy) throw new Error("Wait for the current settings change to finish.");
    if (fastMode) throw new Error(`OpenOrc does not expose a separate Fast mode control for ${this.profile.name}.`);
    const effortId = this.profile.effortOption;
    if (effort !== undefined && !effortId) throw new Error(`Choose a model variant to change reasoning in ${this.profile.name}.`);
    if (model === undefined && effort === undefined) return;
    const previousModel = selectedModel(this.options, this.profile);
    const previousEffort = this.options?.find((option) => option.id === effortId);
    // Without a snapshot we cannot restore a partially applied selection. The core can resume a new process instead.
    if (!previousModel) throw new Error(`${this.profile.name} did not report its current settings. Restart the session to change them.`);
    this.busy = true;
    try {
      await withSettingsRollback(
        async () => {
          if (model !== undefined) await this.set("model", model);
          if (effort !== undefined && effortId) await this.set(effortId, effort);
        },
        async () => {
          await this.set("model", previousModel);
          if (effortId && previousEffort?.type === "select") await this.set(effortId, previousEffort.currentValue);
        },
        this.close,
      );
    } finally {
      this.busy = false;
    }
  }

  private async set(id: string, value: string): Promise<Options> {
    const options = await this.write(id, value);
    if (options) this.options = options;
    return options;
  }
}

/** Apply the saved selection after opening or loading a session. */
export async function initialSettings(
  options: SessionConfigOption[] | null | undefined,
  spec: RunSpec,
  profile: AcpProfile,
  set: (id: string, value: string) => Promise<SessionConfigOption[] | null | undefined>,
): Promise<SessionConfigOption[] | null | undefined> {
  if (spec.effort && !profile.effortOption) throw new Error(`Choose a model variant to change reasoning in ${profile.name}.`);
  const mode = profile.modeValue(spec.mode ?? "act", spec.permissionMode);
  if (profile.modeInLaunch) {
    const selected = options?.find((option) => option.id === "mode");
    if (selected?.type !== "select" || selected.currentValue !== mode) throw new Error(`${profile.name} did not apply the requested permission mode.`);
  } else options = await set("mode", mode);
  if (spec.model) options = await set("model", spec.model);
  if (spec.effort && profile.effortOption) options = await set(profile.effortOption, spec.effort);
  return options;
}

/** Split a saved connection/model choice before sending the native model value. */
export async function setModelOption(
  value: string,
  profile: AcpProfile,
  set: (id: string, value: string) => Promise<SessionConfigOption[] | null | undefined>,
): Promise<SessionConfigOption[] | null | undefined> {
  if (!profile.providerOption) return set("model", value);
  const slash = value.indexOf("/");
  if (slash < 1 || slash === value.length - 1) throw new Error(`Choose a ${profile.name} model from the model picker.`);
  await set(profile.providerOption, value.slice(0, slash));
  return set("model", value.slice(slash + 1));
}

export function selectedModel(options: SessionConfigOption[] | null | undefined, profile: AcpProfile): string | null {
  const model = options?.find((option) => option.id === "model");
  const provider = options?.find((option) => option.id === profile.providerOption);
  if (model?.type !== "select") return null;
  return provider?.type === "select" ? `${provider.currentValue}/${model.currentValue}` : model.currentValue;
}
