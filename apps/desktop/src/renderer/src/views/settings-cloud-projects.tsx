import { useState } from "react";
import type { SpaceProject } from "@openorc/protocol";
import { Button, Dialog, Select, TextButton } from "../components/ui";
import { ProjectEnvironmentDialog } from "../dialogs/ProjectEnvironmentDialog";
import { useRpc, useRpcMutation } from "../lib/client";
import { useRouter } from "../lib/router";
import { Failure } from "./settings-secret-field";
import { Section, SettingRow, Status } from "./settings-shared";

type CloudProject = SpaceProject & { hostedProjectId: string };

const inCloud = (project: SpaceProject): project is CloudProject => project.hostedProjectId !== null;
const repoKey = (repo: string) => repo.toLowerCase();

/** This Mac's projects with a GitHub repository that the space's cloud does not have yet, and which of them GitHub lets OpenOrc read there. */
function useAddable(spaceId: string, added: readonly CloudProject[], active: boolean) {
  const account = useRpc("account.status", {}, { enabled: active });
  const readable = useRpc("organization.repositories", { spaceId }, { enabled: active });
  const there = new Set(added.flatMap((project) => (project.repo ? [repoKey(project.repo)] : [])));
  const repositories = new Map((readable.data?.repositories ?? []).map((repository) => [repoKey(repository.fullName), repository]));
  const mine = account.data?.state === "signed-in" ? account.data.projects : [];
  return { rest: readable.data ? mine.filter((project) => !there.has(repoKey(project.repo))) : [], repositories };
}
type Addable = ReturnType<typeof useAddable>;

/**
 * One picker for this Mac's projects the space can add; a repository GitHub doesn't let OpenOrc read names why beside
 * it. Add makes it one of the space's cloud projects. A route that names a project, as a new thread's OpenOrc Cloud
 * choice sends, picks it.
 */
function AddProject({ spaceId, addable: { rest, repositories }, first }: { spaceId: string; addable: Addable; first: boolean }) {
  const add = useRpcMutation("organization.projects.add");
  const asked = useRouter((s) => (s.route.view === "settings" ? s.route.project : undefined));
  const [picked, setPicked] = useState<string | null>(null);
  const names = new Map((useRpc("projects.list", {}).data ?? []).map((project) => [project.id, project.name]));
  const open = rest.filter((project) => repositories.has(repoKey(project.repo)));
  const id = [picked, asked].find((each) => open.some((project) => project.projectId === each)) ?? open[0]?.projectId ?? "";
  const refused = add.data?.find((result) => result.state === "refused");
  const submit = () => {
    const repository = repositories.get(repoKey(open.find((project) => project.projectId === id)?.repo ?? ""));
    if (repository) add.mutate({ spaceId, repositories: [{ installationId: repository.installationId, repoId: repository.repoId }] });
  };
  return (
    <>
      <SettingRow label={first ? "Add a project" : "Add another project"}>
        <Select aria-label="Project" value={id} disabled={add.isPending} onChange={(event) => setPicked(event.target.value)}>
          {rest.map((project) => {
            const name = names.get(project.projectId) ?? project.repo;
            const readableHere = repositories.has(repoKey(project.repo));
            return (
              <option key={project.projectId} value={project.projectId} disabled={!readableHere}>
                {readableHere ? name : `${name} · GitHub doesn't let OpenOrc read it yet`}
              </option>
            );
          })}
        </Select>
        <Button disabled={!id || add.isPending} onClick={submit}>
          Add
        </Button>
      </SettingRow>
      {refused?.state === "refused" ? <p className="text-bad py-2">{refused.error}</p> : null}
      <Failure error={add.error} />
    </>
  );
}

/** Asks before a cloud project goes: its cloud threads go with it. */
function RemoveProject({ spaceId, project, onClose }: { spaceId: string; project: CloudProject; onClose: () => void }) {
  const remove = useRpcMutation("organization.projects.remove");
  return (
    <Dialog open onOpenChange={(open) => (open || remove.isPending ? undefined : onClose())} title="Remove from the cloud?">
      <p className="text-base text-ink-2 break-words">
        Remove <span className="text-ink">{project.name}</span> from your cloud? Its cloud threads are deleted with it. The folder on this Mac stays.
      </p>
      <Failure error={remove.error} />
      <div className="mt-5 flex justify-end gap-2">
        <Button disabled={remove.isPending} onClick={onClose}>
          Cancel
        </Button>
        <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate({ spaceId, projectId: project.hostedProjectId }, { onSuccess: onClose })}>
          {remove.isPending ? "Removing…" : "Remove"}
        </Button>
      </div>
    </Dialog>
  );
}

/** One of the person's own cloud projects: its environment, where the server keeps one, and Remove. */
function PersonalRow({ spaceId, project, environment }: { spaceId: string; project: CloudProject; environment: boolean }) {
  const [open, setOpen] = useState<"environment" | "remove" | null>(null);
  return (
    <SettingRow label={project.name} hint={project.repo ?? undefined}>
      {environment ? (
        <TextButton tone="muted" onClick={() => setOpen("environment")}>
          Environment
        </TextButton>
      ) : null}
      <TextButton tone="muted" onClick={() => setOpen("remove")}>
        Remove
      </TextButton>
      {open === "environment" ? <ProjectEnvironmentDialog spaceId={spaceId} project={project} onClose={() => setOpen(null)} /> : null}
      {open === "remove" ? <RemoveProject spaceId={spaceId} project={project} onClose={() => setOpen(null)} /> : null}
    </SettingRow>
  );
}

/**
 * A space's cloud projects, one list per space: the person's own in "Personal projects", each with its environment and
 * Remove, and an organization's under its name, as the projects of the account's card showed them before. Below them,
 * this Mac's projects that space can add.
 */
export function SpaceCloudProjects({ spaceId, title, personal, active }: { spaceId: string; title: string; personal: boolean; active: boolean }) {
  const projects = useRpc("spaces.projects", { spaceId }, { enabled: active });
  const environment = useRpc("hostedEnvironment.available", { spaceId }, { enabled: active && personal, staleTime: 60_000 }).data === true;
  const added = (projects.data ?? []).filter(inCloud);
  const addable = useAddable(spaceId, added, active);
  if (projects.error) return <Failure error={projects.error} />;
  if (!projects.data) return null;
  return (
    <Section title={title}>
      {added.map((project) =>
        personal ? (
          <PersonalRow key={project.key} spaceId={spaceId} project={project} environment={environment} />
        ) : (
          <SettingRow key={project.key} label={project.name} hint={project.repo ?? undefined}>
            <Status ok>Added</Status>
          </SettingRow>
        ),
      )}
      {addable.rest.length ? <AddProject spaceId={spaceId} addable={addable} first={!added.length} /> : null}
      {added.length || addable.rest.length ? null : <SettingRow label="No projects">{null}</SettingRow>}
    </Section>
  );
}
