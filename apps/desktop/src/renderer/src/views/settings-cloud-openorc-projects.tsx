import type { AccountStatus } from "@openorc/protocol";
import { Button, TextButton } from "../components/ui";
import { GithubRepositoryChooser } from "../components/GithubRepositoryChooser";
import { useRpcMutation } from "../lib/client";
import { Failure } from "./settings-secret-field";
import { SettingRow, Status } from "./settings-shared";

type SignedIn = Extract<AccountStatus, { state: "signed-in" }>;

/**
 * The person's GitHub on OpenOrc Cloud, which lets it read their repositories and names their commits.
 *   not connected   Connect GitHub
 *   connecting      waiting on the browser, with Cancel
 *   connected       who it is and what it reaches, Choose repositories names one account to manage or connect
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
  const chooser = (
    <GithubRepositoryChooser
      data={{ ...github, installations: github.installations ?? [] }}
      waiting={busy}
      connect={(choice) => connect.mutate(choice)}
      label={connected ? "Choose repositories" : "Connect GitHub"}
      button={!connected}
    />
  );
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
    if (!connected) return chooser;
    return (
      <>
        <Status ok>Connected</Status>
        {github.login ? (
          <TextButton tone="muted" disabled={busy} onClick={() => disconnect.mutate({})}>
            Disconnect
          </TextButton>
        ) : null}
        {chooser}
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
