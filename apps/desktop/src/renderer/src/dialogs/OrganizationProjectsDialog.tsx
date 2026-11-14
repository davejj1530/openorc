import { useRef, useState } from "react";
import type { OrganizationProjectAdded, OrganizationRepositories } from "@openorc/protocol";
import { Button, Checkbox, Dialog, Input } from "../components/ui";
import { useRpc, useRpcMutation } from "../lib/client";
import "../components/Organization.css";

type Repository = OrganizationRepositories["repositories"][number];
const keyOf = (repository: Pick<Repository, "installationId" | "repoId">) => `${repository.installationId}:${repository.repoId}`;

export function OrganizationProjectsDialog({ open, spaceId, onOpenChange, onAdded }: { open: boolean; spaceId: string; onOpenChange(open: boolean): void; onAdded(): void | Promise<void> }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Add projects" width={460}>
      <RepositoryPicker key={spaceId} spaceId={spaceId} onOpenChange={onOpenChange} onAdded={onAdded} />
    </Dialog>
  );
}

function RepositoryPicker({ spaceId, onOpenChange, onAdded }: { spaceId: string; onOpenChange(open: boolean): void; onAdded(): void | Promise<void> }) {
  const read = useRpc("organization.repositories", { spaceId }, { refetchInterval: 2000 });
  const connect = useRpcMutation("organization.github.connect");
  const add = useRpcMutation("organization.projects.add");
  const [chosen, setChosen] = useState<string[]>([]);
  const [outcomes, setOutcomes] = useState<OrganizationProjectAdded[]>([]);
  const submitting = useRef(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const data = read.data;
  const selected = (data?.repositories ?? []).filter((repository) => chosen.includes(keyOf(repository)) && !isAdded(repository, outcomes));
  const submit = async () => {
    if (submitting.current || !selected.length) return;
    submitting.current = true;
    try {
      const result = await add.mutateAsync({ spaceId, repositories: selected.map(({ installationId, repoId }) => ({ installationId, repoId })) });
      setOutcomes((before) => [...before.filter((outcome) => !result.some((next) => keyOf(next) === keyOf(outcome))), ...result]);
      try {
        await onAdded();
      } catch (error) {
        setReadError(error instanceof Error ? error.message : "OpenOrc Cloud can't be reached.");
        return;
      }
      if (result.every((outcome) => outcome.state === "added")) onOpenChange(false);
    } catch {
      /* The mutation retains its readable error and the chosen repositories. */
    } finally {
      submitting.current = false;
    }
  };
  const error = repositoryError(data, add.error, connect.error, read.error);
  const waiting = connect.isPending || data?.connecting?.state === "waiting";
  return (
    <div className="organization-form">
      {!data ? <p className="text-sm text-ink-3">{read.isError ? "Repositories couldn't load." : "Loading repositories…"}</p> : null}
      {data && !data.installations.length ? <GithubConnection configured={data.configured} waiting={waiting} connect={() => connect.mutate({ spaceId })} /> : null}
      {data && data.installations.length > 0 ? <RepositoryChoices data={data} chosen={chosen} onChosen={setChosen} outcomes={outcomes} pending={add.isPending} /> : null}
      <RepositoryReadError error={readError} outcomes={outcomes} />
      {error ? (
        <p className="organization-error" role="alert">
          {error}
        </p>
      ) : null}
      {readError ? (
        <div className="organization-actions">
          <Button onClick={() => onOpenChange(false)}>Close</Button>
          <Button
            variant="primary"
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              void Promise.resolve()
                .then(onAdded)
                .then(
                  () => {
                    setReadError(null);
                    if (!selected.length) onOpenChange(false);
                  },
                  (error: unknown) => setReadError(error instanceof Error ? error.message : "OpenOrc Cloud can't be reached."),
                )
                .finally(() => setRetrying(false));
            }}
          >
            {retrying ? "Trying…" : "Try again"}
          </Button>
        </div>
      ) : null}
      {!readError && (data?.installations.length || read.isError) ? (
        <RepositoryActions
          failed={read.isError}
          retry={() => void read.refetch()}
          cancel={() => onOpenChange(false)}
          canAdd={Boolean(data?.installations.length)}
          count={selected.length}
          pending={add.isPending}
          submit={submit}
        />
      ) : null}
    </div>
  );
}

function RepositoryReadError({ error, outcomes }: { error: string | null; outcomes: OrganizationProjectAdded[] }) {
  if (!error) return null;
  return (
    <div>
      {outcomes.some((outcome) => outcome.state === "added") ? <p>Projects added.</p> : null}
      <p className="organization-error" role="alert">
        {error}
      </p>
    </div>
  );
}

function repositoryError(data: OrganizationRepositories | undefined, add: Error | null, connect: Error | null, read: Error | null): string | undefined {
  return add?.message ?? connect?.message ?? (data?.connecting?.state === "failed" ? data.connecting.error : null) ?? read?.message;
}

function GithubConnection({ configured, waiting, connect }: { configured: boolean; waiting: boolean; connect(): void }) {
  return (
    <div className="organization-connect-row">
      <span>GitHub</span>
      <Button variant="primary" disabled={!configured || waiting} data-tip={!configured ? "GitHub isn't available on this server." : undefined} onClick={connect}>
        {waiting ? "Connecting…" : "Connect"}
      </Button>
    </div>
  );
}

function RepositoryActions({
  failed,
  retry,
  cancel,
  canAdd,
  count,
  pending,
  submit,
}: {
  failed: boolean;
  retry(): void;
  cancel(): void;
  canAdd: boolean;
  count: number;
  pending: boolean;
  submit(): Promise<void>;
}) {
  const label = count ? `Add ${count} project${count === 1 ? "" : "s"}` : "Add projects";
  return (
    <div className="organization-actions">
      {failed ? <Button onClick={retry}>Try again</Button> : null}
      <Button onClick={cancel}>Cancel</Button>
      {canAdd ? (
        <Button variant="primary" disabled={!count || pending} onClick={() => void submit()}>
          {pending ? "Adding…" : label}
        </Button>
      ) : null}
    </div>
  );
}

function isAdded(repository: Repository, outcomes: OrganizationProjectAdded[]): boolean {
  return Boolean(repository.projectId || outcomes.some((outcome) => keyOf(outcome) === keyOf(repository) && outcome.state === "added"));
}

function RepositoryChoices({
  data,
  chosen,
  onChosen,
  outcomes,
  pending,
}: {
  data: OrganizationRepositories;
  chosen: string[];
  onChosen(chosen: string[]): void;
  outcomes: OrganizationProjectAdded[];
  pending: boolean;
}) {
  const [search, setSearch] = useState("");
  return (
    <>
      <Input variant="sheet" placeholder="Find a repository" aria-label="Find repositories" value={search} onChange={(event) => setSearch(event.target.value)} />
      <div className="organization-repositories">
        {data.repositories
          .filter((repository) => repository.fullName.toLowerCase().includes(search.toLowerCase()))
          .map((repository) => {
            const added = isAdded(repository, outcomes);
            const outcome = outcomes.find((outcome) => keyOf(outcome) === keyOf(repository));
            return (
              <div key={keyOf(repository)}>
                <label className="organization-repository">
                  <Checkbox
                    checked={added || chosen.includes(keyOf(repository))}
                    disabled={added || pending}
                    onChange={(event) => onChosen(event.target.checked ? [...chosen, keyOf(repository)] : chosen.filter((key) => key !== keyOf(repository)))}
                  />
                  <span className="min-w-0 break-words">
                    {repository.fullName.split("/").at(-1)}
                    <span className="organization-small">{repository.fullName}</span>
                  </span>
                  {added ? <span className="text-xs text-ink-3 ml-auto">Added</span> : null}
                </label>
                {outcome?.state === "refused" ? (
                  <p className="organization-error" role="alert">
                    {outcome.error}
                  </p>
                ) : null}
              </div>
            );
          })}
        {!data.repositories.length ? <p className="text-sm text-ink-3">No repositories available.</p> : null}
      </div>
    </>
  );
}
