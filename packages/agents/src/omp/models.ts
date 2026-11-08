import { modelProviderName } from "../provider-name.js";
import { execFile } from "node:child_process";
import os from "node:os";
import { launchCommand } from "../command-launch.js";
import { inFolder, type AgentLaunchEnvironment } from "../launch-environment.js";
import type { AcpModel } from "../acp/adapter.js";

/** One row of `omp models --json`. */
interface ListedModel {
  provider?: unknown;
  kind?: unknown;
  selector?: unknown;
  name?: unknown;
  thinking?: unknown;
}

/** Effort steps Oh My Pi takes, in order; `auto` and `off` sit outside the scale. */
const LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** The effort a model starts at: Oh My Pi's default level when the model has it, else the nearest below it. */
function startingEffort(efforts: string[], preferred: string | null): string | null {
  if (!efforts.length) return null;
  if (preferred && efforts.includes(preferred)) return preferred;
  const rank = LEVELS.indexOf(preferred ?? "high");
  const below = efforts.filter((effort) => LEVELS.indexOf(effort) <= rank);
  return below.at(-1) ?? efforts[0]!;
}

/**
 * The chat models in an `omp models --json` answer, with the effort levels each takes. `defaults` holds the model and
 * effort Oh My Pi starts a session with, when its settings name them.
 */
export function ompModelsFrom(output: string, defaults: { model: string | null; effort: string | null } = { model: null, effort: null }): AcpModel[] {
  const parsed = JSON.parse(output) as { models?: unknown };
  if (!Array.isArray(parsed.models)) throw new Error("Oh My Pi did not list its models.");
  const models: AcpModel[] = [];
  for (const row of parsed.models as ListedModel[]) {
    if (row.kind !== undefined && row.kind !== "chat") continue;
    if (typeof row.selector !== "string" || typeof row.provider !== "string") continue;
    const efforts = Array.isArray(row.thinking) ? row.thinking.filter((level): level is string => typeof level === "string" && LEVELS.includes(level)) : [];
    models.push({
      id: row.selector,
      label: typeof row.name === "string" && row.name ? row.name : row.selector,
      provider: { id: row.provider, label: modelProviderName(row.provider) },
      isDefault: row.selector === defaults.model,
      efforts,
      defaultEffort: startingEffort(efforts, defaults.effort),
    });
  }
  return models;
}

/** The model a `modelRoles.default` value names, without the effort suffix Oh My Pi lets it carry. */
function roleModel(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const effort = /:(minimal|low|medium|high|xhigh|max|auto|off)$/.exec(value);
  return effort ? value.slice(0, effort.index) : value;
}

function run(launch: AgentLaunchEnvironment, args: string[], cwd: string): Promise<string> {
  const command = launchCommand(launch.binary, args);
  return new Promise((resolve, reject) => {
    execFile(command.file, command.args, { ...command.options, cwd, env: inFolder({ ...launch.env }, cwd), timeout: 30_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new Error(`Oh My Pi could not list its models: ${error.message.split("\n")[0]}`));
      else resolve(String(stdout));
    });
  });
}

/** A setting's value from `omp config get <key> --json`, or null when it cannot be read. */
async function setting(launch: AgentLaunchEnvironment, key: string, cwd: string): Promise<unknown> {
  try {
    return (JSON.parse(await run(launch, ["config", "get", key, "--json"], cwd)) as { value?: unknown }).value ?? null;
  } catch {
    return null;
  }
}

/**
 * The models Oh My Pi can run, from its own catalog. It lists only providers it can reach, and each model carries its
 * effort levels, so no session is opened to read them.
 */
export async function listOmpModels(launch: AgentLaunchEnvironment, cwd = os.homedir()): Promise<AcpModel[]> {
  const [listed, roles, effort] = await Promise.all([run(launch, ["models", "--json"], cwd), setting(launch, "modelRoles", cwd), setting(launch, "defaultThinkingLevel", cwd)]);
  const model = roles && typeof roles === "object" ? roleModel((roles as Record<string, unknown>)["default"]) : null;
  return ompModelsFrom(listed, { model, effort: typeof effort === "string" ? effort : null });
}
