import type { AccountProject, AccountStatus } from "@openorc/protocol";
import { useState } from "react";
import { Button, Select, TextButton } from "../components/ui";
import { useRpc, useRpcMutation } from "../lib/client";
import { useRouter } from "../lib/router";
import { Failure } from "./settings-secret-field";
import { SettingRow, Status } from "./settings-shared";

type SignedIn = Extract<AccountStatus, { state: "signed-in" }>;

/**
 * The person's GitHub on OpenOrc Cloud, which lets it read their repositories and names their commits.
 *   not connected   Connect GitHub
 *   connecting      waiting on the browser, with Cancel
 *   connected       who it is and what it reaches, Choose repositories (the same trip, to change what the app reaches)
 *                   and Disconnect, which unlinks the account
 *   failed          the words, and Connect GitHub again
 * Absent when the server has no GitHub app.
 */
export function GithubRow({ account }: { account: SignedIn }) {
  const connect = useRpcMutation("account.github.connect");
  const cancel = useRpcMutation("account.github.cancel");
  const disconnect = useRpcMutation("account.github.disconnect");
  const { github, connectingGithub: work } = account;
  if (!github?.configured) return null;
  const busy = connect.isPending || cancel.isPending || disconnect.isPending;
  const connected = github.login !== null || github.installedOn.length > 0;
  const controls = () => {
    if (work?.state === "waiting")
      return (
        <>
          <Status>Waiting for GitHub</Status>
          <Button variant="ghost" disabled={busy} onClick={() => cancel.mutate({})}>
            Cancel
          </Button>
        </>
      );
    if (!connected)
      return (
        <Button disabled={busy} onClick={() => connect.mutate({})}>
          Connect GitHub
        </Button>
      );
    return (
      <>
        <Status ok>Connected</Status>
        {github.login ? (
          <TextButton tone="muted" disabled={busy} onClick={() => disconnect.mutate({})}>
            Disconnect
          </TextButton>
        ) : null}
        <TextButton tone="muted" disabled={busy} onClick={() => connect.mutate({})}>
          Choose repositories
        </TextButton>
      </>
    );
  };
  return (
    <>
      <SettingRow label="GitHub" hint={githubHint(account)}>
        {controls()}
      </SettingRow>
      <Failure error={connect.error ?? cancel.error ?? disconnect.error} />
    </>
  );
}

function githubHint({ github, connectingGithub: work }: SignedIn) {
  if (work?.state === "waiting") return "Finish on GitHub in the browser that opened.";
  if (work?.state === "failed") return <span className="text-bad">{work.error}</span>;
  if (!github) return undefined;
  const reach = github.repositories.length === 1 ? "1 repository" : `${github.repositories.length} repositories`;
  if (github.login) return `${github.login} · ${reach}`;
  return github.installedOn.length ? reach : undefined;
}

/**
 * This Mac's projects on OpenOrc Cloud, matched by their GitHub repository: each one added as a row, and one picker for
 * the rest, where a repository GitHub doesn't let OpenOrc read names why beside it. The picker shows once one can be
 * added; until then the GitHub row is the way on. A route that names a project, as a new thread's OpenOrc Cloud choice
 * sends, picks it.
 */
export function CloudProjects({ account, active }: { account: SignedIn; active: boolean }) {
  const projects = useRpc("projects.list", {}, { enabled: active });
  const add = useRpcMutation("account.projects.add");
  const asked = useRouter((s) => (s.route.view === "settings" ? s.route.project : undefined));
  const [picked, setPicked] = useState<string | null>(null);
  const names = new Map((projects.data ?? []).map((project) => [project.id, project.name]));
  const name = (project: AccountProject) => names.get(project.projectId) ?? project.repo;
  const added = account.projects.filter((project) => project.cloud === "added" || (add.isPending && add.variables?.projectId === project.projectId));
  const rest = account.projects.filter((project) => !added.includes(project));
  const open = rest.filter((project) => project.cloud === "addable");
  const id = [picked, asked].find((each) => open.some((project) => project.projectId === each)) ?? open[0]?.projectId ?? "";
  return (
    <>
      {added.map((project) => (
        <SettingRow key={project.projectId} label={name(project)} hint={project.repo}>
          <Status ok={project.cloud === "added"}>{project.cloud === "added" ? "Added" : "Adding"}</Status>
        </SettingRow>
      ))}
      {open.length ? (
        <SettingRow label={added.length ? "Add another project" : "Add a project"}>
          <Select aria-label="Project" value={id} disabled={add.isPending} onChange={(event) => setPicked(event.target.value)}>
            {rest.map((project) => (
              <option key={project.projectId} value={project.projectId} disabled={project.cloud !== "addable"}>
                {project.cloud === "addable" ? name(project) : `${name(project)} · GitHub doesn't let OpenOrc read it yet`}
              </option>
            ))}
          </Select>
          <Button disabled={!id || add.isPending} onClick={() => add.mutate({ projectId: id })}>
            Add
          </Button>
        </SettingRow>
      ) : null}
      <Failure error={add.error} />
    </>
  );
}
