import { withSettingsRollback } from "../live-settings.js";
import type { LiveSettings } from "../run-handle.js";
import { piModelsFrom, piState } from "./models.js";
import type { PiRpc } from "./rpc.js";

/** Pi can change models and thinking levels without throwing away the live session. */
export async function applyPiSettings(rpc: PiRpc, { model, effort, fastMode }: LiveSettings): Promise<void> {
  if (fastMode) throw new Error("Pi does not expose a separate Fast mode control.");
  if (model === undefined && effort === undefined) return;
  const before = piState.parse(await rpc.request("get_state"));
  if (!before.model) throw new Error("Pi has no selected model.");
  const previous = before.model;
  const selected = model ?? `${previous.provider}/${previous.id}`;
  const available = piModelsFrom(await rpc.request("get_available_models"), before).find((candidate) => candidate.id === selected);
  if (!available) throw new Error(`Pi cannot run ${selected}. Refresh models and check the provider's credentials.`);
  if (effort !== undefined && !available.efforts.includes(effort)) throw new Error(`Pi does not offer ${effort} effort for ${available.label}.`);
  const slash = selected.indexOf("/");
  await withSettingsRollback(
    async () => {
      if (model !== undefined) await rpc.request("set_model", { provider: selected.slice(0, slash), modelId: selected.slice(slash + 1) });
      if (effort !== undefined) await rpc.request("set_thinking_level", { level: effort });
      const after = piState.parse(await rpc.request("get_state"));
      if (`${after.model?.provider}/${after.model?.id}` !== selected || (effort !== undefined && after.thinkingLevel !== effort)) throw new Error("Pi did not apply the requested model settings.");
    },
    async () => {
      await rpc.request("set_model", { provider: previous.provider, modelId: previous.id });
      await rpc.request("set_thinking_level", { level: before.thinkingLevel });
      const restored = piState.parse(await rpc.request("get_state"));
      if (`${restored.model?.provider}/${restored.model?.id}` !== `${previous.provider}/${previous.id}` || restored.thinkingLevel !== before.thinkingLevel)
        throw new Error("Pi could not restore its settings.");
    },
    () => rpc.close(),
  );
}
