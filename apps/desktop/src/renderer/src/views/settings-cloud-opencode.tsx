import { useState } from "react";
import { openCodeProviderName, type CloudStatus } from "@openorc/protocol";
import { Button, Input, Select, TextButton } from "../components/ui";
import { useRpc, useRpcMutation } from "../lib/client";
import { Section, SettingRow, Status } from "./settings-shared";
import { Failure, TokenField } from "./settings-secret-field";

/** OpenCode's own provider, OpenCode Zen: its free models need no key, its paid ones take one. */
const FREE = "opencode";

/** The providers people most often add a key for, after this Mac's own. */
const COMMON = ["anthropic", "openai", "openrouter", "google", "groq", "mistral", "xai", "deepseek", FREE];

/** The choice that takes a provider's name typed in, as OpenCode writes it in a model id. */
const TYPED = "typed";

/** The providers whose API keys Oh My Pi takes in the cloud; its sign-ins with an account stay on this Mac. */
const OMP_KEYED = new Set(["anthropic", "openai", "openrouter", "google", "groq", "mistral", "xai", "deepseek"]);

/** The providers this Mac's OpenCode and Oh My Pi serve models from, by id, with the names they give them. */
function useProviders(): Map<string, string> {
  const opencode = useRpc("agents.models", { agent: "opencode" }, { staleTime: 5 * 60_000 });
  const omp = useRpc("agents.models", { agent: "omp" }, { staleTime: 5 * 60_000 });
  const listed = [...(opencode.data ?? []).filter((model) => model.provider?.id !== FREE), ...(omp.data ?? []).filter((model) => model.provider && OMP_KEYED.has(model.provider.id))];
  const names = new Map<string, string>();
  for (const model of listed) if (model.provider && !names.has(model.provider.id)) names.set(model.provider.id, model.provider.label);
  return names;
}

/** A provider to add a key for: this Mac's own first, then the common ones, then any other typed in. */
function ProviderChoice({ here, others, value, onChange }: { here: [string, string][]; others: [string, string][]; value: string; onChange: (choice: string) => void }) {
  const options = (choices: [string, string][]) =>
    choices.map(([id, label]) => (
      <option key={id} value={id}>
        {label}
      </option>
    ));
  return (
    <Select value={value} onChange={(event) => onChange(event.target.value)}>
      {here.length ? <optgroup label="On this Mac">{options(here)}</optgroup> : null}
      {here.length && others.length ? <optgroup label="Others">{options(others)}</optgroup> : options(others)}
      <option value={TYPED}>Another provider…</option>
    </Select>
  );
}

/**
 * Provider keys for the cloud, one per provider, entered here or copied from this Mac's OpenCode. OpenCode and Oh My Pi
 * share them. A cloud turn gets only the key of its model's provider, which an agent in its sandbox can read, as the
 * section says.
 */
export function OpenCodeCloudSection({ opencode }: { opencode: CloudStatus["opencode"] }) {
  const save = useRpcMutation("cloud.opencode.saveKey");
  const remove = useRpcMutation("cloud.opencode.removeKey");
  const names = useProviders();
  const open = (id: string) => !opencode.providers.includes(id);
  const here = [...names].filter(([id]) => open(id));
  const others = COMMON.filter((id) => open(id) && !names.has(id)).map((id): [string, string] => [id, openCodeProviderName(id)]);
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState("");
  const [typed, setTyped] = useState("");
  const choice = picked || here[0]?.[0] || others[0]?.[0] || TYPED;
  const provider = choice === TYPED ? typed : choice;
  const busy = save.isPending || remove.isPending;
  return (
    <Section title="OpenCode and Oh My Pi" description="OpenCode and Oh My Pi sign in to sandboxes with a key for each provider. An agent in a sandbox can read the key its model uses.">
      {opencode.providers.map((id) => (
        <SettingRow key={id} label={names.get(id) ?? openCodeProviderName(id)}>
          <Status ok>Key saved</Status>
          <TextButton tone="muted" disabled={busy} onClick={() => remove.mutate({ provider: id })}>
            Remove
          </TextButton>
        </SettingRow>
      ))}
      {adding ? (
        <>
          <SettingRow label="Provider">
            <ProviderChoice here={here} others={others} value={choice} onChange={setPicked} />
          </SettingRow>
          {choice === TYPED ? (
            <SettingRow label="Provider name">
              <Input value={typed} placeholder="As in a model id, like togetherai" spellCheck={false} onChange={(event) => setTyped(event.target.value.trim().toLowerCase())} />
            </SettingRow>
          ) : null}
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
                    setTyped("");
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
