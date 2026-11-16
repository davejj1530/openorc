import { CloudMachinesSection } from "./settings-cloud-machines";
import { OpenOrcCloudSection, useOpenOrcCloudShown } from "./settings-cloud-openorc";
import { CloudSkillsSection } from "./settings-cloud-skills";

/** Settings > Cloud: where a Pro person's OpenOrc Cloud threads run, how their agents sign in there, what goes there, and what runs. */
export function CloudSettings({ active }: { active: boolean }) {
  const shown = useOpenOrcCloudShown(active);
  return (
    <>
      <OpenOrcCloudSection active={active} />
      {shown ? <CloudSkillsSection active={active} /> : null}
      {shown ? <CloudMachinesSection active={active} /> : null}
    </>
  );
}
