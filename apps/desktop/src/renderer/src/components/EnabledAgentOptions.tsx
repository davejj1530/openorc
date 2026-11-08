import { harnessCatalog, type HarnessId } from "@openorc/protocol";
import { useEnabledHarnesses } from "../lib/enabled-harnesses";

/** Options shared by settings that choose a coding agent. */
export function EnabledAgentOptions({ harnesses }: { harnesses?: readonly HarnessId[] }) {
  const enabled = useEnabledHarnesses(harnesses);
  return (
    <>
      {enabled.map((id) => (
        <option key={id} value={id}>
          {harnessCatalog[id].name}
        </option>
      ))}
    </>
  );
}
