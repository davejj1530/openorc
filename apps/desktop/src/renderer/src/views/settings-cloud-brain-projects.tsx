import { useState } from "react";
import type { CloudBrainProject, RpcParams } from "@openorc/protocol";
import { Button, Select, Switch, Tooltip } from "../components/ui";
import { queryClient, useRpc, useRpcMutation } from "../lib/client";
import { CloudEnvButton } from "./settings-cloud-env";
import { Failure } from "./settings-secret-field";
import { Section, SettingRow, Status } from "./settings-shared";

const shown = (projects: CloudBrainProject[]) => queryClient.setQueryData(["cloud.brain.projects", {}], projects);

function hint({ error, kept }: CloudBrainProject) {
  if (error) return <span className="text-bad">{error}</span>;
  return kept ? "The cloud copy has commits this Mac doesn't, so it wasn't updated." : undefined;
}

type Choose = {
  mutate(params: RpcParams<"cloud.brain.project">, options: { onSuccess: (projects: CloudBrainProject[]) => void }): void;
  isPending: boolean;
  variables: RpcParams<"cloud.brain.project"> | undefined;
};

/** A project the brain has a copy of, switched off to let it go. A blocked switch says why on hover. */
function OnProject({ project, choose }: { project: CloudBrainProject; choose: Choose }) {
  const pending = choose.isPending && choose.variables?.projectId === project.id ? choose.variables : null;
  const toggle = (
    <Switch
      aria-label={project.name}
      checked={pending ? pending.on : project.on}
      disabled={pending !== null || project.blocked !== null}
      onChange={(e) => choose.mutate({ projectId: project.id, on: e.target.checked }, { onSuccess: shown })}
    />
  );
  return (
    <SettingRow label={project.name} hint={hint(project)}>
      {project.sending ? <Status>Sending</Status> : null}
      <CloudEnvButton project={project} />
      {project.blocked ? <Tooltip label={project.blocked}>{toggle}</Tooltip> : toggle}
    </SettingRow>
  );
}

/** The rest of this Mac's projects in one picker; one that cannot go names why beside its name. */
function AddProject({ projects, first, choose }: { projects: CloudBrainProject[]; first: boolean; choose: Choose }) {
  const [picked, setPicked] = useState("");
  const open = projects.filter((project) => !project.blocked);
  const id = open.some((project) => project.id === picked) ? picked : (open[0]?.id ?? "");
  if (!projects.length) return null;
  return (
    <SettingRow label={first ? "Add a project" : "Add another"} hint={first ? "Threads you start from your phone work in its copy." : undefined}>
      <Select aria-label="Project" value={id} disabled={choose.isPending || !open.length} onChange={(e) => setPicked(e.target.value)}>
        {projects.map((project) => (
          <option key={project.id} value={project.id} disabled={project.blocked !== null}>
            {project.blocked ? `${project.name} · ${project.blocked}` : project.name}
          </option>
        ))}
      </Select>
      <Button disabled={!id || choose.isPending} onClick={() => choose.mutate({ projectId: id, on: true }, { onSuccess: shown })}>
        Add
      </Button>
    </SettingRow>
  );
}

/**
 * The projects the cloud brain has a copy of, each switched off to let it go, and one picker to add another of this
 * Mac's, so a long project list stays one row.
 */
export function CloudBrainProjects({ active }: { active: boolean }) {
  const list = useRpc("cloud.brain.projects", {}, { enabled: active });
  const choose = useRpcMutation("cloud.brain.project");
  if (!list.data?.length) return null;
  const adding = (project: CloudBrainProject) => choose.isPending && choose.variables?.projectId === project.id && choose.variables.on;
  const on = list.data.filter((project) => project.on || adding(project));
  return (
    <Section title="Projects">
      {on.map((project) => (
        <OnProject key={project.id} project={project} choose={choose} />
      ))}
      <AddProject projects={list.data.filter((project) => !on.includes(project))} first={!on.length} choose={choose} />
      <Failure error={choose.error} />
    </Section>
  );
}
