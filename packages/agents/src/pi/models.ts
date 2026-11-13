import os from "node:os";
import { z } from "zod";
import type { ModelOption } from "@openorc/protocol";
import type { AgentLaunchEnvironment } from "../launch-environment.js";
import { modelProviderName } from "../provider-name.js";
import { PiRpc } from "./rpc.js";

export const piModel = z.object({
  id: z.string(),
  provider: z.string(),
  name: z.string(),
  reasoning: z.boolean(),
  thinkingLevelMap: z.record(z.string(), z.unknown()).optional(),
  contextWindow: z.number().optional(),
});
export const piState = z.object({ sessionId: z.string(), model: piModel.optional(), thinkingLevel: z.string() });
const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Match Pi's advertised thinking-level map, including explicitly unsupported steps. */
export function piModelsFrom(value: unknown, state: z.infer<typeof piState>): ModelOption[] {
  return z
    .object({ models: z.array(piModel) })
    .parse(value)
    .models.map((model) => {
      const efforts = model.reasoning
        ? levels.filter((level) => model.thinkingLevelMap?.[level] !== null && (!(level === "xhigh" || level === "max") || model.thinkingLevelMap?.[level] !== undefined))
        : [];
      const isDefault = state.model?.provider === model.provider && state.model.id === model.id;
      let defaultEffort = efforts.includes("medium") ? "medium" : (efforts[0] ?? null);
      if (efforts.includes(state.thinkingLevel)) defaultEffort = state.thinkingLevel;
      return {
        id: `${model.provider}/${model.id}`,
        label: model.name,
        agent: "pi",
        provider: { id: model.provider, label: modelProviderName(model.provider) },
        isDefault,
        efforts,
        defaultEffort,
        fastMode: { supported: false, reason: "Pi does not expose a separate Fast mode control." },
      };
    });
}

export async function listPiModels(launch: AgentLaunchEnvironment): Promise<ModelOption[]> {
  const rpc = new PiRpc(launch, launch.env["HOME"] || os.homedir(), ["--mode", "rpc", "--no-session", "--offline", "--no-approve", "--no-extensions", "--no-mcp"]);
  try {
    const [models, state] = await Promise.all([rpc.request("get_available_models"), rpc.request("get_state")]);
    return piModelsFrom(models, piState.parse(state));
  } finally {
    rpc.close();
    await rpc.done;
  }
}

/** The CLI lists only models with usable provider credentials or configured local endpoints. */
export function piAuthenticated(output: string): boolean | null {
  if (/No models available\./.test(output)) return false;
  return /^provider\s+model\s+context\s+max-out\s+thinking\s+images\s*\n\S/m.test(output) ? true : null;
}
