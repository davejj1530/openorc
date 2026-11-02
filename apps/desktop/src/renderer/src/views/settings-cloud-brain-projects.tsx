import type { CloudBrainProject } from "@openorc/protocol";
import { Switch, Tooltip } from "../components/ui";
import { queryClient, useRpc, useRpcMutation } from "../lib/client";
import { SettingRow, Status } from "./settings-shared";

function hint({ error, kept }: CloudBrainProject) {
  if (error) return <span className="text-bad">{error}</span>;
  return kept ? "The cloud copy has commits this Mac doesn't, so it wasn't updated." : undefined;
}

/** This Mac's projects, each switched on to have a copy on the cloud brain. A blocked switch says why on hover. */
export function CloudBrainProjects({ active }: { active: boolean }) {
  const list = useRpc("cloud.brain.projects", {}, { enabled: active });
  const choose = useRpcMutation("cloud.brain.project");
  if (!list.data?.length) return null;
  return (
    <>
      <p className="settings-storage-label pt-4">Projects</p>
      {list.data.map((project) => {
        const pending = choose.isPending && choose.variables?.projectId === project.id;
        const toggle = (
          <Switch
            aria-label={project.name}
            checked={pending ? choose.variables.on : project.on}
            disabled={pending || project.blocked !== null}
            onChange={(e) => choose.mutate({ projectId: project.id, on: e.target.checked }, { onSuccess: (projects) => queryClient.setQueryData(["cloud.brain.projects", {}], projects) })}
          />
        );
        return (
          <SettingRow key={project.id} label={project.name} hint={hint(project)}>
            {project.sending ? <Status>Sending</Status> : null}
            {project.blocked ? <Tooltip label={project.blocked}>{toggle}</Tooltip> : toggle}
          </SettingRow>
        );
      })}
    </>
  );
}
