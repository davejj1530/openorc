import { useState, type ReactNode } from "react";
import {
  SANDBOX_VCPUS,
  type BrainRegion,
  type ClaudeAccountConnection,
  type ClaudeCloudAccess,
  type CloudBrainStatus,
  type CloudService,
  type CloudSignIns,
  type CloudStatus,
} from "@openorc/protocol";
import { Button, Select, TextButton, Tooltip } from "../components/ui";
import { useRpc, useRpcMutation } from "../lib/client";
import { Agent37Settings, CloudServiceChoice } from "./settings-cloud-agent37";
import { CloudBrain } from "./settings-cloud-brain";
import { BrainCodexRow, BrainGitHubSection } from "./settings-cloud-brain-signins";
import { RegionSelect } from "./settings-cloud-place";
import { CloudCheckCard } from "./settings-cloud-check";
import { CloudSandboxesSection } from "./settings-cloud-sandboxes";
import { CloudSkillsSection } from "./settings-cloud-skills";
import { BringMissing, missingRows } from "./settings-cloud-sign-ins";
import { CloudStep, cloudSteps, nextStep, serviceOf, type CloudStepId } from "./settings-cloud-steps";
import { Field, LoadError, Section, SettingRow, Status, Toggle } from "./settings-shared";
import { CodexCloudSection } from "./settings-cloud-codex";
import { OpenCodeCloudSection } from "./settings-cloud-opencode";
import { Failure, StillWorks, TokenField } from "./settings-secret-field";
import { useRouter } from "../lib/router";

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
        hint="While a thread in a worktree works, a sandbox keeps a copy of it. If this Mac sleeps mid-task, the sandbox finishes the task and the thread moves to the cloud."
        checked={takeover.isPending && takeover.variables ? takeover.variables.enabled : enabled}
        disabled={takeover.isPending}
        onChange={(next) => takeover.mutate({ enabled: next })}
      />
      <Failure error={takeover.error} />
    </Section>
  );
}

/** The services connected: Vercel once it has a team, Agent37 once it has a key. */
const connected = (status: CloudStatus): CloudService[] => [...(status.vercel?.team ? (["vercel"] as const) : []), ...(status.agent37 ? (["agent37"] as const) : [])];

/** Both services, a connected one first, and the choice between them once both are. */
function ServiceStep({ status }: { status: CloudStatus }) {
  const vercel = <VercelSettings key="vercel" status={status} />;
  const agent37 = <Agent37Settings key="agent37" status={status} />;
  return (
    <>
      {status.agent37 && !status.vercel ? [agent37, vercel] : [vercel, agent37]}
      <CloudServiceChoice status={status} />
    </>
  );
}

/**
 * Every sign-in the cloud uses, in one place: the one row that brings each missing one, then each agent's, the cloud
 * brain's own Codex login and GitHub among them once there is a brain.
 */
function SignInsStep({ status, signIns, brain, active }: { status: CloudStatus; signIns: CloudSignIns | undefined; brain: CloudBrainStatus | undefined; active: boolean }) {
  const onBrain = signIns?.rows.some((row) => row.kind === "brain-codex") ?? false;
  const busy = brain?.state === "ready" && brain.working !== null;
  return (
    <>
      {signIns && (signIns.bringing || missingRows(signIns).length) ? (
        <div className="settings-group cloud-step-lead">
          <BringMissing signIns={signIns} />
        </div>
      ) : null}
      <ClaudeCloudAccounts status={status} active={active} />
      <CodexCloudSection codex={status.codex} brain={onBrain ? <BrainCodexRow active={active} busy={busy} /> : undefined} />
      <OpenCodeCloudSection opencode={status.opencode} />
      {onBrain ? <BrainGitHubSection active={active} busy={busy} /> : null}
    </>
  );
}

/** The step a person opened or closed; the others follow `nextStep`, and one worked in stays open. */
function useOpenSteps(next: CloudStepId | null) {
  // Asked to add a project to the cloud brain, as from a new thread's Cloud choice: its step opens.
  const adding = useRouter((s) => (s.route.view === "settings" ? s.route.project : undefined));
  const [chosen, setChosen] = useState<Partial<Record<CloudStepId, boolean>>>(() => (adding ? { brain: true } : {}));
  const open = (id: CloudStepId) => chosen[id] ?? id === next;
  return {
    open,
    toggle: (id: CloudStepId) => setChosen((was) => ({ ...was, [id]: !open(id) })),
    work: (id: CloudStepId) => setChosen((was) => (was[id] === undefined ? { ...was, [id]: true } : was)),
  };
}

/**
 * Where cloud threads run and how their agents sign in, as the steps to get there: connect a service, sign the agents
 * in, check a cloud thread runs, then the optional cloud brain. Tokens go to the core and stay in protected storage.
 */
export function CloudSettings({ active }: { active: boolean }) {
  const status = useRpc("cloud.status", {}, { enabled: active });
  const signIns = useRpc("cloud.signIns", {}, { enabled: active });
  const offer = useRpc("cloud.offer", {}, { enabled: active });
  const service = status.data ? serviceOf(status.data) : null;
  const brain = useRpc("cloud.brain.status", {}, { enabled: active && service !== null });
  const steps = status.data ? cloudSteps({ status: status.data, place: offer.data?.provider ?? null, signIns: signIns.data, brain: brain.data }) : null;
  const next = steps ? nextStep(steps) : null;
  const { open, toggle, work } = useOpenSteps(next);
  if (status.isError) return <LoadError retry={() => void status.refetch()} />;
  if (!status.data || !steps) return null;
  const step = (id: CloudStepId, body: ReactNode) => (
    <CloudStep key={id} id={id} view={steps[id]} next={id === next} open={open(id)} onToggle={() => toggle(id)} onWork={() => work(id)}>
      {body}
    </CloudStep>
  );
  return (
    <>
      {status.data.error ? (
        <p role="alert" className="text-bad my-3">
          {status.data.error}
        </p>
      ) : null}
      <div className="cloud-steps">
        {step("service", <ServiceStep status={status.data} />)}
        {step("signins", <SignInsStep status={status.data} signIns={signIns.data} brain={brain.data} active={active} />)}
        {step("check", <CloudCheckCard check={status.data.check} place={offer.data?.provider ?? null} />)}
        {step("brain", service ? <CloudBrain active={active} service={service} services={connected(status.data)} /> : null)}
      </div>
      <Failure error={signIns.error ?? offer.error} />
      {service ? (
        <>
          <TakeoverSection enabled={status.data.takeover} />
          <CloudSkillsSection active={active} />
          <CloudSandboxesSection active={active} />
        </>
      ) : null}
    </>
  );
}
