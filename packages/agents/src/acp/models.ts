import type { client, SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AcpModel } from "./adapter.js";
import type { AcpProfile } from "./profile.js";

export async function readModels(
  connection: ReturnType<ReturnType<typeof client>["connect"]>,
  profile: AcpProfile,
  configOptions: SessionConfigOption[] | null | undefined,
  sessionId: string,
): Promise<AcpModel[]> {
  if (profile.providerOption) {
    const option = configOptions?.find((option) => option.id === profile.providerOption);
    if (!option || option.type !== "select") throw new Error(`${profile.name} did not report its provider connections.`);
    const models: AcpModel[] = [];
    for (const provider of option.options.flatMap((entry) => ("options" in entry ? entry.options : [entry]))) {
      const isDefault = provider.value === option.currentValue;
      let options = configOptions;
      if (!isDefault) {
        try {
          options = (await connection.agent.request("session/set_config_option", { sessionId, configId: profile.providerOption, value: provider.value })).configOptions;
        } catch {
          // fx advertises built-in connections even when they have no credentials.
          continue;
        }
      } else {
        options = (await connection.agent.request("session/set_config_option", { sessionId, configId: profile.providerOption, value: provider.value })).configOptions;
      }
      const rows = await readProviderModels(connection, profile, options, sessionId, { id: provider.value, label: provider.name });
      models.push(...rows.map((row) => ({ ...row, id: `${provider.value}/${row.id}`, isDefault: isDefault && row.isDefault })));
    }
    return models;
  }
  return readProviderModels(connection, profile, configOptions, sessionId, profile.modelAccount);
}

async function readProviderModels(
  connection: ReturnType<ReturnType<typeof client>["connect"]>,
  profile: AcpProfile,
  configOptions: SessionConfigOption[] | null | undefined,
  sessionId: string,
  account: { id: string; label: string } | undefined,
): Promise<AcpModel[]> {
  const models: AcpModel[] = [];
  // ACP's effort option describes only the selected model. Query each in
  // this disposable session; never copy one model's levels to its peers.
  for (const model of modelsFrom(configOptions, account)) {
    if (!profile.effortOption) {
      models.push({ ...model, efforts: [], defaultEffort: null });
      continue;
    }
    const options = model.isDefault ? configOptions : (await connection.agent.request("session/set_config_option", { sessionId, configId: "model", value: model.id })).configOptions;
    const option = options?.find((option) => option.id === profile.effortOption);
    const effort = option?.type === "select" ? option : undefined;
    const efforts = effortValues(effort);
    // "default" clears the variant override; a current value can otherwise
    // have been inherited from the previously selected model.
    let defaultEffort: string | null = null;
    if (efforts.includes("default")) defaultEffort = "default";
    else if (efforts.length === 1) defaultEffort = efforts[0]!;
    models.push({ ...model, efforts, defaultEffort });
  }
  return models;
}

function effortValues(effort: SessionConfigOption | undefined): string[] {
  return effort?.type === "select" ? effort.options.flatMap((entry) => ("options" in entry ? entry.options : [entry])).map((entry) => entry.value) : [];
}

/** The `model` option lists every model the agent can run and which one is current. */
export function modelsFrom(options: SessionConfigOption[] | null | undefined, account?: { id: string; label: string }): Omit<AcpModel, "efforts" | "defaultEffort">[] {
  const option = options?.find((candidate) => candidate.id === "model");
  if (!option || option.type !== "select") return [];
  // Options come flat or grouped by provider; either way each entry is one model.
  const entries = option.options.flatMap((entry) => ("options" in entry ? entry.options : [entry]));
  return entries.map((entry) => {
    if (account) return { id: entry.value, label: entry.name, provider: account, isDefault: entry.value === option.currentValue };
    const slash = entry.value.indexOf("/");
    const providerId = slash === -1 ? entry.value : entry.value.slice(0, slash);
    const labelSlash = entry.name.indexOf("/");
    const providerLabel = labelSlash === -1 ? providerId : entry.name.slice(0, labelSlash);
    const label = labelSlash === -1 ? entry.name : entry.name.slice(labelSlash + 1);
    return { id: entry.value, label, provider: { id: providerId, label: providerLabel }, isDefault: entry.value === option.currentValue };
  });
}
