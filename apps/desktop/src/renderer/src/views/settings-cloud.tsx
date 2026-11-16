import { OpenOrcCloudSection, useOpenOrcCloudShown } from "./settings-cloud-openorc";
import { CloudSkillsSection } from "./settings-cloud-skills";

/** Settings > Cloud: where a Pro person's OpenOrc Cloud threads run, how their agents sign in there, and what goes there. */
export function CloudSettings({ active }: { active: boolean }) {
  const shown = useOpenOrcCloudShown(active);
  return (
    <>
      <OpenOrcCloudSection active={active} />
      {shown ? <CloudSkillsSection active={active} /> : null}
    </>
  );
}
