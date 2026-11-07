import { useState } from "react";
import type { CloudStatus } from "@openorc/protocol";
import { Button, Input, Select, TextButton } from "../components/ui";
import { useRpc, useRpcMutation } from "../lib/client";
import { Section, SettingRow, Status } from "./settings-shared";
import { Failure, TokenField } from "./settings-secret-field";

/** OpenCode's own provider: its free models need no key. */
const FREE = "opencode";

/** The providers this Mac's OpenCode serves models from, by id, with the names OpenCode gives them. */
function useProviders(): Map<string, string> {
  const models = useRpc("agents.models", { agent: "opencode" }, { staleTime: 5 * 60_000 });
  return new Map((models.data ?? []).flatMap((model) => (model.provider && model.provider.id !== FREE ? [[model.provider.id, model.provider.label] as const] : [])));
}

/** A provider to add a key for: one of OpenCode's here, or typed when this Mac's OpenCode lists none. */
function ProviderChoice({ choices, value, onChange }: { choices: [string, string][]; value: string; onChange: (provider: string) => void }) {
  if (!choices.length) return <Input value={value} placeholder="Provider, as in openrouter" spellCheck={false} onChange={(event) => onChange(event.target.value.trim().toLowerCase())} />;
  return (
    <Select value={value} onChange={(event) => onChange(event.target.value)}>
      {choices.map(([id, label]) => (
        <option key={id} value={id}>
          {label}
        </option>
      ))}
    </Select>
  );
}

/**
 * OpenCode's keys for the cloud, one per provider, entered here or copied from this Mac's OpenCode. A cloud turn
 * gets only the key of its model's provider, which an agent in its sandbox can read, as the section says.
 */
export function OpenCodeCloudSection({ opencode }: { opencode: CloudStatus["opencode"] }) {
  const save = useRpcMutation("cloud.opencode.saveKey");
  const remove = useRpcMutation("cloud.opencode.removeKey");
  const names = useProviders();
  const choices = [...names].filter(([id]) => !opencode.providers.includes(id));
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState("");
  const provider = picked || choices[0]?.[0] || "";
  const busy = save.isPending || remove.isPending;
  return (
    <Section title="OpenCode" description="OpenCode signs in to sandboxes with a key for each provider. An agent in a sandbox can read the key its model uses.">
      {opencode.providers.map((id) => (
        <SettingRow key={id} label={names.get(id) ?? id}>
          <Status ok>Key saved</Status>
          <TextButton tone="muted" disabled={busy} onClick={() => remove.mutate({ provider: id })}>
            Remove
          </TextButton>
        </SettingRow>
      ))}
      {adding ? (
        <>
          <SettingRow label="Provider">
            <ProviderChoice choices={choices} value={provider} onChange={setPicked} />
          </SettingRow>
          <TokenField
            label="API key"
            placeholder="Paste key"
            hint="Removing it here leaves it working at the provider until you delete it there."
            action="Save"
            busy={busy || !provider}
            onSave={(key) =>
              save.mutate(
                { provider, key },
                {
                  onSuccess: () => {
                    setAdding(false);
                    setPicked("");
                  },
                },
              )
            }
          />
        </>
      ) : (
        <SettingRow label={opencode.providers.length ? "Another provider" : "Provider keys"}>
          <Button variant="ghost" disabled={busy} onClick={() => setAdding(true)}>
            Add a key
          </Button>
        </SettingRow>
      )}
      <Failure error={save.error ?? remove.error} />
    </Section>
  );
}
