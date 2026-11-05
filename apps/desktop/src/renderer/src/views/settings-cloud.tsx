import { useState, type ReactNode } from "react";
import { SANDBOX_VCPUS, type BrainRegion, type ClaudeAccountConnection, type ClaudeCloudAccess, type CloudStatus } from "@openorc/protocol";
import { Button, Select, TextButton, Tooltip } from "../components/ui";
import { useRpc, useRpcMutation } from "../lib/client";
import { Agent37Settings, CloudServiceChoice } from "./settings-cloud-agent37";
import { CloudBrainSection, RegionSelect } from "./settings-cloud-brain";
import { CloudCheckSection } from "./settings-cloud-check";
import { CloudSandboxesSection } from "./settings-cloud-sandboxes";
import { Field, LoadError, Section, SettingRow, Status, Toggle } from "./settings-shared";
import { CodexCloudSection } from "./settings-cloud-codex";
import { OpenCodeCloudSection } from "./settings-cloud-opencode";
import { Failure, StillWorks, TokenField } from "./settings-secret-field";

const TOKENS_URL = "https://vercel.com/account/tokens";
/** Why a token scoped to one team, said on hover. */
const MASTER_KEY = "Whoever holds the token can change everything it reaches.";

/** Vercel's default when none is chosen. */
const DEFAULT_VCPUS = 2;

/** How big new sandboxes are. Vercel refuses more than the team's plan allows when it makes one. */
function SandboxSize({ vcpus, disabled }: { vcpus: number | null; disabled: boolean }) {
  const size = useRpcMutation("cloud.vercel.size");
  return (
    <>
      <Field label="Sandbox size" hint="New sandboxes get this size.">
        <Select value={String(vcpus ?? DEFAULT_VCPUS)} disabled={disabled || size.isPending} onChange={(e) => size.mutate({ vcpus: Number(e.target.value) as (typeof SANDBOX_VCPUS)[number] })}>
          {SANDBOX_VCPUS.map((count) => (
            <option key={count} value={count}>
              {count} vCPUs · {count * 2} GB
            </option>
          ))}
        </Select>
      </Field>
      <Failure error={size.error} />
    </>
  );
}

/** Where new sandboxes run. One that exists stays in the region it was made in. */
function SandboxRegion({ region, disabled }: { region: BrainRegion; disabled: boolean }) {
  const choose = useRpcMutation("cloud.vercel.region");
  return (
    <>
      <Field label="Sandbox region" hint="New sandboxes run here.">
        <RegionSelect value={region} disabled={disabled || choose.isPending} onChange={(next) => choose.mutate({ region: next })} />
      </Field>
      <Failure error={choose.error} />
    </>
  );
}

function VercelTeam({ vercel }: { vercel: NonNullable<CloudStatus["vercel"]> }) {
  const teams = useRpc("cloud.vercel.teams", {});
  const choose = useRpcMutation("cloud.vercel.team");
  const disconnect = useRpcMutation("cloud.vercel.disconnect");
  const busy = choose.isPending || disconnect.isPending;
  return (
    <>
      <Field label="Team" hint={vercel.project ? `Sandboxes belong to its ${vercel.project} project.` : "Choose where sandboxes run."}>
        <Select value={vercel.team?.id ?? ""} disabled={busy || !teams.data} onChange={(e) => e.target.value && choose.mutate({ teamId: e.target.value })}>
          {vercel.team ? null : <option value="">Choose a team</option>}
          {(teams.data ?? (vercel.team ? [vercel.team] : [])).map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </Select>
      </Field>
      <SandboxSize vcpus={vercel.vcpus} disabled={busy || !vercel.team} />
      <SandboxRegion region={vercel.region} disabled={busy || !vercel.team} />
      <SettingRow
        label="Account"
        hint={
          vercel.team && vercel.reachesMore ? (
            <Tooltip label={`${MASTER_KEY} Disconnect, then connect one scoped to ${vercel.team.name} alone.`}>This token reaches more than {vercel.team.name}.</Tooltip>
          ) : null
        }
      >
        <Status ok={Boolean(vercel.team)}>{vercel.team ? "Connected" : "Choose a team"}</Status>
        <Button variant="ghost" disabled={busy} onClick={() => disconnect.mutate({})}>
          Disconnect
        </Button>
      </SettingRow>
      <Failure error={teams.error ?? choose.error ?? disconnect.error} />
    </>
  );
}

function VercelSettings({ status }: { status: CloudStatus }) {
  const connect = useRpcMutation("cloud.vercel.connect");
  return (
    <Section title="Vercel" description="Cloud threads run in Vercel Sandbox, on your account.">
      {status.vercel ? (
        <VercelTeam vercel={status.vercel} />
      ) : (
        <>
          <TokenField
            label="Access token"
            hint={
              <>
                Create one in{" "}
                <TextButton underline onClick={() => window.openorc.openExternal(TOKENS_URL)}>
                  your Vercel account
                </TextButton>
                , <Tooltip label={`Under Scope, choose the team, then All Projects. ${MASTER_KEY}`}>scoped to one team</Tooltip>.
              </>
            }
            action="Connect"
            busy={connect.isPending}
            onSave={(token) => connect.mutate({ token })}
          />
          <Failure error={connect.error} />
        </>
      )}
    </Section>
  );
}

function accountDetail(account: ClaudeAccountConnection): string {
  return [account.email, account.organization].filter(Boolean).join(" · ") || (account.kind === "cli" ? "Your Claude Code login" : "Added account");
}

/** Where the browser sign-in opens, and which login to use there, since a token cannot say whose it is. */
function signInHint(account: ClaudeAccountConnection): string {
  const who = account.email ? `as ${account.email}` : "with this account";
  return account.kind === "managed" ? `Sign in ${who} in the private window that opened.` : `Sign in ${who} in your browser.`;
}

/** Once its token was removed, until another is made or pasted: where to revoke the old one. */
function revoked(removed: boolean, access: ClaudeCloudAccess | undefined): "claude" | null {
  return removed && !access?.createdAt && !access?.creating ? "claude" : null;
}

function ClaudeCloudAccount({ account, access }: { account: ClaudeAccountConnection; access: ClaudeCloudAccess | undefined }) {
  const create = useRpcMutation("cloud.claude.create");
  const cancel = useRpcMutation("cloud.claude.cancel");
  const save = useRpcMutation("cloud.claude.save");
  const remove = useRpcMutation("cloud.claude.remove");
  const [pasting, setPasting] = useState(false);
  const busy = create.isPending || cancel.isPending || save.isPending || remove.isPending;
  const accountId = account.id;
  const ready = access?.createdAt != null;
  const make = () => create.mutate({ accountId });
  let controls: ReactNode;
  if (access?.creating)
    controls = (
      <>
        <Status>Waiting for sign-in</Status>
        <Button variant="ghost" disabled={busy} onClick={() => cancel.mutate({ accountId })}>
          Cancel
        </Button>
      </>
    );
  else if (ready)
    controls = (
      <>
        <Status ok>Ready</Status>
        <TextButton tone="muted" disabled={busy} onClick={make}>
          Replace
        </TextButton>
        <TextButton tone="muted" disabled={busy} onClick={() => remove.mutate({ accountId })}>
          Remove
        </TextButton>
      </>
    );
  else
    controls = (
      <>
        <Button disabled={busy} onClick={make}>
          Create token
        </Button>
        <TextButton tone="muted" disabled={busy} onClick={() => setPasting(!pasting)}>
          Paste token
        </TextButton>
      </>
    );
  return (
    <>
      <SettingRow label={account.name} hint={access?.creating ? signInHint(account) : accountDetail(account)}>
        {controls}
      </SettingRow>
      {pasting && !ready && !access?.creating ? (
        <TokenField
          label="Token"
          hint={
            <>
              From <code>claude setup-token</code>, signed in as this account.
            </>
          }
          action="Save"
          busy={busy}
          onSave={(token) => save.mutate({ accountId, token }, { onSuccess: () => setPasting(false) })}
        />
      ) : null}
      <StillWorks at={revoked(remove.isSuccess, access)} />
      <Failure error={create.error ?? cancel.error ?? save.error ?? remove.error ?? (access?.error ? new Error(access.error) : null)} />
    </>
  );
}

/** One row per enabled Claude account: each signs in to sandboxes with its own token, on its own subscription. */
function ClaudeCloudAccounts({ status, active }: { status: CloudStatus; active: boolean }) {
  const accounts = useRpc("claude.accounts.list", {}, { enabled: active });
  return (
    <Section title="Claude accounts" description="Each account signs in to sandboxes with a token from its own subscription.">
      {accounts.data?.accounts
        .filter((account) => account.enabled)
        .map((account) => (
          <ClaudeCloudAccount key={account.id} account={account} access={status.claude[account.id]} />
        ))}
      <Failure error={accounts.error} />
    </Section>
  );
}

/** Whether a thread working on this Mac carries on in the cloud when the Mac goes to sleep. */
function TakeoverSection({ enabled }: { enabled: boolean }) {
  const takeover = useRpcMutation("cloud.takeover");
  return (
    <Section title="When this Mac sleeps">
      <Toggle
        label="Carry working threads on in the cloud"
        hint="A thread in a worktree keeps working in its sandbox while this Mac sleeps, and its turn shows here when the Mac wakes."
        checked={takeover.isPending && takeover.variables ? takeover.variables.enabled : enabled}
        disabled={takeover.isPending}
        onChange={(next) => takeover.mutate({ enabled: next })}
      />
      <Failure error={takeover.error} />
    </Section>
  );
}

/** Where cloud threads run and how their agents sign in. Tokens go to the core and stay in protected storage. */
export function CloudSettings({ active }: { active: boolean }) {
  const status = useRpc("cloud.status", {}, { enabled: active });
  if (status.isError) return <LoadError retry={() => void status.refetch()} />;
  if (!status.data) return null;
  return (
    <>
      {status.data.error ? (
        <p role="alert" className="text-bad my-3">
          {status.data.error}
        </p>
      ) : null}
      <VercelSettings status={status.data} />
      <Agent37Settings status={status.data} />
      <CloudServiceChoice status={status.data} />
      <ClaudeCloudAccounts status={status.data} active={active} />
      <CodexCloudSection codex={status.data.codex} />
      <OpenCodeCloudSection opencode={status.data.opencode} />
      {status.data.vercel?.team ? <CloudBrainSection active={active} /> : null}
      <TakeoverSection enabled={status.data.takeover} />
      <CloudSandboxesSection active={active} />
      <CloudCheckSection status={status.data} />
    </>
  );
}
