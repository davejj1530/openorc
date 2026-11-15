import { OpenOrcCloudSection } from "./settings-cloud-openorc";

/** Settings > Cloud: where a Pro person's OpenOrc Cloud threads run and how their agents sign in there. */
export function CloudSettings({ active }: { active: boolean }) {
  return <OpenOrcCloudSection active={active} />;
}
