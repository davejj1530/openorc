import { harnessCatalog, harnessIds, type MemorySettings } from "@openorc/protocol";

const joined = (items: string[]) => (items.length < 3 ? items.join(" and ") : `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`);

/** Who summarizes finished runs, in one sentence, so turning memory on says where run content goes. Null while memory is off. */
export function extractionSummary(settings: MemorySettings): string | null {
  if (!settings.enabled) return null;
  if (settings.provider === "off") return "Finished runs are not summarized. Agents can still save memories.";
  if (settings.provider === "auto") {
    if (settings.automatic.length === 0) return settings.reason;
    const covered = new Set(settings.automatic.map((extraction) => extraction.provider));
    const own = settings.automatic.map((extraction) => `${harnessCatalog[extraction.provider].name} runs by ${extraction.label}`);
    const skipped = harnessIds.filter((id) => !covered.has(id)).map((id) => harnessCatalog[id].name);
    return `Each finished run is summarized by the agent that ran it: ${joined(own)}.${skipped.length ? ` ${joined(skipped)} runs are not summarized.` : ""}`;
  }
  const { resolved } = settings;
  if (!resolved) return settings.reason;
  return `Every finished run, whichever agent did the work, is summarized by ${resolved.label} through ${resolved.viaApiKey ? "your Anthropic API key" : harnessCatalog[resolved.provider].name}.`;
}
