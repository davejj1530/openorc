import { useState, type ReactNode } from "react";
import type { CloudStatus } from "@openorc/protocol";
import { Button, Input, Select, TextButton } from "../components/ui";
import { useRpc, useRpcMutation } from "../lib/client";
import { Field, LoadError, Section, SettingRow, Status } from "./settings-shared";

const TOKENS_URL = "https://vercel.com/account/settings/tokens";

function Failure({ error }: { error: Error | null | undefined }) {
  return error ? (
    <p role="alert" className="text-bad mt-2">
      {error.message}
    </p>
  ) : null;
}

/** A secret typed once: it goes to the core and the field empties. */
function TokenField({ label, hint, action, busy, onSave }: { label: string; hint: ReactNode; action: string; busy: boolean; onSave: (token: string) => void }) {
  const [token, setToken] = useState("");
  return (
    <SettingRow label={label} hint={hint}>
      <Input type="password" autoComplete="off" spellCheck={false} value={token} disabled={busy} placeholder="Paste token" onChange={(e) => setToken(e.target.value)} />
      <Button
        disabled={busy || !token.trim()}
        onClick={() => {
          onSave(token.trim());
          setToken("");
        }}
      >
        {action}
      </Button>
    </SettingRow>
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
      <SettingRow label="Account">
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
                .
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

function ClaudeTokenSettings({ status }: { status: CloudStatus }) {
  const save = useRpcMutation("cloud.claude.save");
  const remove = useRpcMutation("cloud.claude.remove");
  return (
    <Section title="Claude" description="Claude signs in to each sandbox with a token from your subscription.">
      {status.claude ? (
        <SettingRow label="Token">
          <Status ok>Saved</Status>
          <Button variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate({})}>
            Remove
          </Button>
        </SettingRow>
      ) : (
        <TokenField
          label="Token"
          hint={
            <>
              Run <code>claude setup-token</code> in Terminal and paste what it prints.
            </>
          }
          action="Save"
          busy={save.isPending}
          onSave={(token) => save.mutate({ token })}
        />
      )}
      <Failure error={save.error ?? remove.error} />
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
      <ClaudeTokenSettings status={status.data} />
    </>
  );
}
