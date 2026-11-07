import { useEffect, useRef, useState } from "react";
import type { CloudBrainCopy, CloudBrainProject, CloudEnv, RpcParams } from "@openorc/protocol";
import { GitBranch } from "../components/icons";
import { Button, Dialog, Select, TextButton, Tooltip } from "../components/ui";
import { queryClient, useRpc, useRpcMutation } from "../lib/client";
import { useRouter } from "../lib/router";
import { CloudEnvButton, ENV_NOTE, EnvEditor, useEnvDraft } from "./settings-cloud-env";
import { Failure } from "./settings-secret-field";
import { Section, SettingRow, Status } from "./settings-shared";

const shown = (projects: CloudBrainProject[]) => queryClient.setQueryData(["cloud.brain.projects", {}], projects);

function hint({ error, kept, branch }: CloudBrainProject) {
  if (error) return <span className="text-bad">{error}</span>;
  if (kept) return "The cloud copy has commits this Mac doesn't, so it wasn't updated.";
  return branch ? `Follows ${branch}` : undefined;
}

/** The branch a copy takes and the commit it is on now, and the branch checked out here when it is another. */
function CopyBranch({ copy }: { copy: CloudBrainCopy }) {
  return (
    <div className="space-y-1.5">
      <div className="flex min-w-0 items-center gap-2 rounded-lg bg-surface-2 px-3 py-2.5" aria-label="Branch copied">
        <GitBranch size={14} className="shrink-0 text-ink-3" />
        <span className="shrink-0 font-mono">{copy.branch}</span>
        <span className="shrink-0 font-mono text-ink-4">{copy.commit}</span>
        <span className="min-w-0 truncate text-ink-3">{copy.subject}</span>
      </div>
      {copy.checkedOut ? (
        <p className="text-ink-3">
          This Mac has <span className="font-mono">{copy.checkedOut}</span> checked out. Its work stays here until it reaches {copy.branch}.
        </p>
      ) : null}
    </div>
  );
}

type Choose = {
  mutate(params: RpcParams<"cloud.brain.project">, options: { onSuccess: (projects: CloudBrainProject[]) => void }): void;
  isPending: boolean;
  variables: RpcParams<"cloud.brain.project"> | undefined;
};

/** A project the brain has a copy of: its environment, and Remove to let the copy go. A blocked Remove says why on hover. */
function OnProject({ project, choose }: { project: CloudBrainProject; choose: Choose }) {
  const pending = choose.isPending && choose.variables?.projectId === project.id ? choose.variables : null;
  const remove = (
    <TextButton tone="muted" disabled={pending !== null || project.blocked !== null} onClick={() => choose.mutate({ projectId: project.id, on: false }, { onSuccess: shown })}>
      Remove
    </TextButton>
  );
  return (
    <SettingRow label={project.name} hint={hint(project)}>
      {project.sending || pending?.on ? <Status>Sending</Status> : null}
      {pending && !pending.on ? <Status>Removing</Status> : null}
      <CloudEnvButton project={project} />
      {project.blocked ? <Tooltip label={project.blocked}>{remove}</Tooltip> : remove}
    </SettingRow>
  );
}

/**
 * The sheet that adds a project: what the brain gets of it, and the environment its threads need, filled from its .env
 * files while it has none saved. Adding saves the environment first, so the copy's first thread has it.
 */
function AddSheet({
  project,
  names,
  preview,
  choose,
  close,
}: {
  project: CloudBrainProject;
  names: string[];
  /** The copy it would take; its error, when it cannot have one now, takes its place and Add waits. */
  preview: { data?: CloudBrainCopy | undefined; error: Error | null };
  choose: Choose;
  close: () => void;
}) {
  const copy = preview.data;
  const draft = useEnvDraft(project.id, names);
  const save = useRpcMutation("cloud.env.set");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- Fills once as the sheet opens; later edits are the person's own.
  useEffect(() => void (names.length ? undefined : draft.fill(true)), []);
  const add = () => {
    const entries = draft.entries();
    const send = () => {
      choose.mutate({ projectId: project.id, on: true }, { onSuccess: shown });
      close();
    };
    if (!entries.length && !names.length) return send();
    save.mutate(
      { projectId: project.id, entries },
      {
        onSuccess: (env: CloudEnv) => {
          queryClient.setQueryData(["cloud.env", { projectId: project.id }], env);
          send();
        },
      },
    );
  };
  return (
    <div className="space-y-3">
      {copy ? <CopyBranch copy={copy} /> : null}
      {preview.error ? (
        <p role="alert" className="text-bad">
          {preview.error.message}
        </p>
      ) : null}
      <p className="text-ink-2">
        Threads you start from your phone work in a copy of {copy ? copy.branch : "its default branch"}, which follows it as it moves. Uncommitted changes and files Git ignores, like .env, stay on
        this Mac.
      </p>
      <p className="text-ink-3">{ENV_NOTE}</p>
      <EnvEditor draft={draft} disabled={save.isPending} />
      <Failure error={save.error} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!copy || save.isPending || draft.filling} onClick={add}>
          Add
        </Button>
      </div>
    </div>
  );
}

/**
 * Asked to add a project, as from a new thread's Cloud choice: its sheet opens once, in view. One that cannot go is
 * left to the picker, which names why.
 */
function useAskedToAdd(projects: CloudBrainProject[], open: (project: CloudBrainProject) => void): void {
  const asked = useRouter((s) => (s.route.view === "settings" ? s.route.project : undefined));
  const opened = useRef<string | null>(null);
  useEffect(() => {
    const project = projects.find((each) => each.id === asked && !each.blocked);
    if (!project || opened.current === project.id) return;
    opened.current = project.id;
    open(project);
  }, [asked, projects, open]);
}

/** The rest of this Mac's projects in one picker; one that cannot go names why beside its name. Add opens its sheet. */
function AddProject({ projects, first, choose }: { projects: CloudBrainProject[]; first: boolean; choose: Choose }) {
  const [picked, setPicked] = useState("");
  const [adding, setAdding] = useState<CloudBrainProject | null>(null);
  useAskedToAdd(projects, setAdding);
  const env = useRpc("cloud.env", { projectId: adding?.id ?? "" }, { enabled: adding !== null });
  const copy = useRpc("cloud.brain.copy", { projectId: adding?.id ?? "" }, { enabled: adding !== null });
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
      <Button disabled={!id || choose.isPending} onClick={() => setAdding(projects.find((project) => project.id === id) ?? null)}>
        Add
      </Button>
      <Dialog open={adding !== null} onOpenChange={(next) => (next ? undefined : setAdding(null))} title={`Add ${adding?.name ?? "a project"} to the cloud brain`} width={560}>
        {adding && env.data ? <AddSheet key={adding.id} project={adding} names={env.data.names} preview={copy} choose={choose} close={() => setAdding(null)} /> : <Failure error={env.error} />}
      </Dialog>
    </SettingRow>
  );
}

/**
 * The projects the cloud brain has a copy of, each with its environment and a way to let it go, and one picker to add
 * another of this Mac's, so a long project list stays one row.
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
