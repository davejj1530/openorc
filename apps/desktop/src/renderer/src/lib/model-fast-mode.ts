import { harnessCatalog, isHarnessId, type ModelOption } from "@openorc/protocol";

/**
 * Capability state for the composer; keep model/CLI failures separate from eligibility.
 * `blocked` means the loaded catalog says this model or account cannot serve Fast,
 * as opposed to not knowing yet.
 */
export function modelFastMode(model: ModelOption | undefined, loading = false, failed = false) {
  if (model?.unavailable) return { supported: false, blocked: true, hint: model.unavailable };
  if (!model?.fastMode) {
    if (loading) return { supported: false, blocked: false, hint: "Loading Fast mode availability…" };
    if (failed) return { supported: false, blocked: false, hint: "Could not load model capabilities. Reopen the model selector to retry." };
    if (!model) return { supported: false, blocked: false, hint: "Choose an available model to configure Fast mode." };
    return { supported: false, blocked: false, hint: "Fast mode availability was not reported. Try Refresh models." };
  }
  const supported = model.fastMode.supported;
  const hint = model.fastMode.reason ?? (supported && isHarnessId(model.agent) ? harnessCatalog[model.agent].fastModeHint : "Fast mode is unavailable for this model.");
  return { supported, blocked: !supported, hint };
}
