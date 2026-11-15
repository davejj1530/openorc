import { Select } from "../components/ui";
import { useRpc } from "../lib/client";
import { thisComputer } from "../lib/this-computer";

/** OpenCode's own provider, OpenCode Zen: its free models need no key, its paid ones take one. */
const FREE = "opencode";

/** The providers people most often add a key for, after this Mac's own. */
export const COMMON = ["anthropic", "openai", "openrouter", "google", "groq", "mistral", "xai", "deepseek", FREE];

/** The choice that takes a provider's name typed in, as OpenCode writes it in a model id. */
export const TYPED = "typed";

/** The providers Oh My Pi takes an API key for; its sign-ins with an account stay on this Mac. */
const OMP_KEYED = new Set(["anthropic", "openai", "openrouter", "google", "groq", "mistral", "xai", "deepseek"]);

/** The providers this Mac's OpenCode and Oh My Pi serve models from, by id, with the names they give them. */
export function useProviders(): Map<string, string> {
  const opencode = useRpc("agents.models", { agent: "opencode" }, { staleTime: 5 * 60_000 });
  const omp = useRpc("agents.models", { agent: "omp" }, { staleTime: 5 * 60_000 });
  const listed = [...(opencode.data ?? []).filter((model) => model.provider?.id !== FREE), ...(omp.data ?? []).filter((model) => model.provider && OMP_KEYED.has(model.provider.id))];
  const names = new Map<string, string>();
  for (const model of listed) if (model.provider && !names.has(model.provider.id)) names.set(model.provider.id, model.provider.label);
  return names;
}

/** A provider to add a key for: this Mac's own first, then the common ones, then any other typed in. */
export function ProviderChoice({ here, others, value, onChange }: { here: [string, string][]; others: [string, string][]; value: string; onChange: (choice: string) => void }) {
  const options = (choices: [string, string][]) =>
    choices.map(([id, label]) => (
      <option key={id} value={id}>
        {label}
      </option>
    ));
  return (
    <Select value={value} onChange={(event) => onChange(event.target.value)}>
      {here.length ? <optgroup label={`On ${thisComputer}`}>{options(here)}</optgroup> : null}
      {here.length && others.length ? <optgroup label="Others">{options(others)}</optgroup> : options(others)}
      <option value={TYPED}>Another provider…</option>
    </Select>
  );
}
