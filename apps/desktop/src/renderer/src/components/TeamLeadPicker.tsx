import type { TeamRevision } from "@openorc/protocol";
import { useOrclings } from "../lib/orclings";
import { pickerTeam } from "../lib/team-settings";
import { ComposerModelPicker, type ModelChoice } from "./ModelPicker";

/** A team conversation's lead control: effort and Fast for a model lead. An Orcling lead keeps its own. */
export function TeamLeadPicker({ revision, value, onChange, saving }: { revision: TeamRevision; value: ModelChoice; onChange: (choice: ModelChoice) => void; saving: boolean }) {
  const orclings = useOrclings();
  const team = pickerTeam(revision, orclings);
  return (
    <ComposerModelPicker
      value={value}
      onChange={onChange}
      team={team}
      settingsDisabled={saving}
      modelSelector={
        <span className="text-sm text-ink-2">
          {team?.leadName} · {value.model}
        </span>
      }
    />
  );
}
