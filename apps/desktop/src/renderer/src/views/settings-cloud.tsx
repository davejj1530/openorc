import { useRpc } from "../lib/client";
import { useSpaceNavigation } from "../lib/space-navigation";
import { CloudMachinesSection } from "./settings-cloud-machines";
import { SpaceCloudProjects } from "./settings-cloud-projects";
import { OpenOrcCloudSection, useOpenOrcCloudShown } from "./settings-cloud-openorc";
import { CloudSkillsSection } from "./settings-cloud-skills";

/** Settings > Cloud: where a Pro person's OpenOrc Cloud threads run, how their agents sign in there, what goes there, and what runs. */
export function CloudSettings({ active }: { active: boolean }) {
  const shown = useOpenOrcCloudShown(active);
  return (
    <>
      <OpenOrcCloudSection active={active} />
      {shown ? <CloudProjectSections active={active} /> : null}
      {shown ? <CloudSkillsSection active={active} /> : null}
      {shown ? <CloudMachinesSection active={active} /> : null}
    </>
  );
}

/** The person's own cloud projects, always, and the projects of the organization they are in now, under its name. */
function CloudProjectSections({ active }: { active: boolean }) {
  const status = useRpc("spaces.status", {}, { enabled: active }).data;
  const current = useSpaceNavigation((state) => state.current);
  if (status?.state !== "ready") return null;
  const organization = status.spaces.find((space) => space.kind === "organization" && space.id === current);
  return (
    <>
      <SpaceCloudProjects spaceId={status.personalSpaceId} title="Personal projects" personal active={active} />
      {organization?.kind === "organization" ? <SpaceCloudProjects spaceId={organization.id} title={organization.name} personal={false} active={active} /> : null}
    </>
  );
}
