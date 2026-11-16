import { useState } from "react";
import type { MacProjectRow, MacProjects } from "@openorc/protocol";
import { Button, Dialog, TextButton } from "../components/ui";
import { ProjectEnvironmentDialog } from "../dialogs/ProjectEnvironmentDialog";
import { queryClient, useRpc, useRpcMutation } from "../lib/client";
import { Failure } from "./settings-secret-field";
import { SettingRow, Status } from "./settings-shared";

/** How often a history on its way is read again. */
const SENDING_MS = 1_000;

const megabytes = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024 / 1024))} MB`;
const shown = (state: MacProjects) => queryClient.setQueryData(["macProjects.read", {}], state);

/** A folder's path with the home folder as ~, as the Finder's people read it. */
function nearby(folder: string): string {
  const home = /^\/Users\/[^/]+/.exec(folder)?.[0];
  return home ? `~${folder.slice(home.length)}` : folder;
}

/** This Mac's mac projects and the folders that could be one; read again each second while a history is on its way. */
export function useMacProjects(active: boolean) {
  return useRpc(
    "macProjects.read",
    {},
    {
      enabled: active,
      refetchInterval: (query) => (active && query.state.data?.state === "ready" && query.state.data.projects.some((one) => one.sending.at === "sending") ? SENDING_MS : false),
    },
  );
}

/** Asks before a mac project goes: its cloud threads go with it, and the count of those whose work never came here. */
function RemoveMacProject({ project, onClose }: { project: MacProjectRow; onClose: () => void }) {
  const unbrought = useRpc("macProjects.unbrought", { hostedProjectId: project.hostedProjectId }, { staleTime: 0 });
  const remove = useRpcMutation("macProjects.cancel");
  const count = unbrought.data?.threads ?? 0;
  return (
    <Dialog open onOpenChange={(open) => (open || remove.isPending ? undefined : onClose())} title={`Remove ${project.name} from the cloud?`}>
      <p className="text-base text-ink-2 break-words">Its cloud threads are deleted with it. The folder on this Mac stays.</p>
      {count ? (
        <p className="mt-2 text-base text-ink-2">
          {count === 1 ? "1 thread has work that never came to this Mac. It's deleted with it." : `${count} threads have work that never came to this Mac. It's deleted with them.`}
        </p>
      ) : null}
      <Failure error={remove.error} />
      <div className="mt-5 flex justify-end gap-2">
        <Button disabled={remove.isPending} onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="danger"
          disabled={remove.isPending || unbrought.isLoading}
          onClick={() => remove.mutate({ hostedProjectId: project.hostedProjectId }, { onSuccess: (state) => (shown(state), onClose()) })}
        >
          {remove.isPending ? "Removing…" : "Remove"}
        </Button>
      </div>
    </Dialog>
  );
}

/** What a mac project's row says under its name: where it came from, or how its history's way up stands. */
function hintOf(project: MacProjectRow) {
  const from = project.folder ? `${nearby(project.folder)} · No remote` : "No remote";
  if (project.sending.at === "sending") return `Sending ${megabytes(project.sending.sent)} of ${megabytes(project.sending.total)}`;
  if (project.sending.at === "failed") return <span className="text-bad">Couldn't send: {project.sending.error}</span>;
  return from;
}

/** One Personal project from a folder of this Mac: its history's way up, its environment, and Remove. */
export function MacProjectRowView({ spaceId, project, environment }: { spaceId: string; project: MacProjectRow; environment: boolean }) {
  const [open, setOpen] = useState<"environment" | "remove" | null>(null);
  const retry = useRpcMutation("macProjects.retry");
  const cancel = useRpcMutation("macProjects.cancel");
  const { sending } = project;
  return (
    <>
      <SettingRow label={project.name} hint={hintOf(project)}>
        {sending.at === "sending" ? (
          <>
            <Status>Sending</Status>
            <TextButton tone="muted" disabled={cancel.isPending} onClick={() => cancel.mutate({ hostedProjectId: project.hostedProjectId }, { onSuccess: shown })}>
              Cancel
            </TextButton>
          </>
        ) : null}
        {sending.at === "failed" ? (
          <Button disabled={retry.isPending} onClick={() => retry.mutate({ hostedProjectId: project.hostedProjectId }, { onSuccess: shown })}>
            Send again
          </Button>
        ) : null}
        {sending.at === "sent" && environment ? (
          <TextButton tone="muted" onClick={() => setOpen("environment")}>
            Environment
          </TextButton>
        ) : null}
        {sending.at === "sending" ? null : (
          <TextButton tone="muted" onClick={() => setOpen("remove")}>
            Remove
          </TextButton>
        )}
        {open === "environment" ? (
          <ProjectEnvironmentDialog
            spaceId={spaceId}
            project={{ key: project.hostedProjectId, name: project.name, repo: null, localProjectId: project.localProjectId, hostedProjectId: project.hostedProjectId, connected: true }}
            onClose={() => setOpen(null)}
          />
        ) : null}
        {open === "remove" ? <RemoveMacProject project={project} onClose={() => setOpen(null)} /> : null}
      </SettingRow>
      <Failure error={retry.error ?? cancel.error} />
    </>
  );
}
