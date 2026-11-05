import { useState } from "react";
import type { CloudBrainSignIns as SignIns } from "@openorc/protocol";
import { Button, Switch, TextButton, Tooltip } from "../components/ui";
import { queryClient, useRpc, useRpcMutation } from "../lib/client";
import { codexWho } from "./settings-cloud-codex";
import { Failure, StillWorks, TokenField, type RevokedAt } from "./settings-secret-field";
import { SettingRow, Status } from "./settings-shared";

const KEYS_URL = "https://platform.openai.com/api-keys";
const shown = (signIns: SignIns) => queryClient.setQueryData(["cloud.brain.signIns", {}], signIns);

/** Sends what changed, the same as the Claude accounts' Send. */
function Send({ busy }: { busy: boolean }) {
  const handover = useRpcMutation("cloud.brain.handover");
  return busy ? null : (
    <TextButton tone="muted" disabled={handover.isPending} onClick={() => handover.mutate({})}>
      Send
    </TextButton>
  );
}

/** Who the brain signs in as, or the login on its way to it. */
function codexHint(codex: SignIns["codex"]): string {
  if (codex.signingIn) return "Sign in to ChatGPT in the browser that opened.";
  const login = codex.pending && codex.pending !== "sign-out" ? codex.pending : codex;
  return login.mode ? codexWho(login) : "None";
}

type CodexActions = { open: () => void; cancel: () => void; remove: () => void; paste: () => void; pending: boolean; busy: boolean };

/** Waiting for the browser or for the brain; signed in, with a way to sign in again or remove it; or the two ways to sign in. */
function CodexControls({ codex, act }: { codex: SignIns["codex"]; act: CodexActions }) {
  if (codex.signingIn)
    return (
      <>
        <Status>Waiting for sign-in</Status>
        <Button variant="ghost" onClick={act.cancel}>
          Cancel
        </Button>
      </>
    );
  if (codex.pending)
    return (
      <>
        <Status>Waiting for the brain</Status>
        <Send busy={act.busy} />
      </>
    );
  if (codex.mode)
    return (
      <>
        {codex.mode === "chatgpt" ? (
          <TextButton tone="muted" disabled={act.pending} onClick={act.open}>
            Sign in again
          </TextButton>
        ) : null}
        <TextButton tone="muted" disabled={act.pending} onClick={act.remove}>
          Remove
        </TextButton>
      </>
    );
  return (
    <>
      <Button disabled={act.pending} onClick={act.open}>
        Sign in
      </Button>
      <TextButton tone="muted" disabled={act.pending} onClick={act.paste}>
        Use an API key
      </TextButton>
    </>
  );
}

/** The brain's own Codex login: a ChatGPT sign-in made from here for it alone, or an API key. */
function BrainCodex({ codex, busy }: { codex: SignIns["codex"]; busy: boolean }) {
  const signIn = useRpcMutation("cloud.brain.codex.signIn");
  const cancel = useRpcMutation("cloud.brain.codex.cancel");
  const apiKey = useRpcMutation("cloud.brain.codex.apiKey");
  const remove = useRpcMutation("cloud.brain.codex.remove");
  const [pasting, setPasting] = useState(false);
  /** The kind of login last removed, until another is begun. */
  const [removed, setRemoved] = useState<RevokedAt | null>(null);
  const pending = signIn.isPending || cancel.isPending || apiKey.isPending || remove.isPending || busy;
  const error = signIn.error ?? cancel.error ?? apiKey.error ?? remove.error ?? (codex.error ? new Error(codex.error) : null);
  const act: CodexActions = {
    open: () => {
      setRemoved(null);
      signIn.mutate({}, { onSuccess: shown });
    },
    cancel: () => cancel.mutate({}, { onSuccess: shown }),
    remove: () => {
      setRemoved(codex.mode);
      remove.mutate({}, { onSuccess: shown });
    },
    paste: () => {
      setRemoved(null);
      setPasting(!pasting);
    },
    pending,
    busy,
  };
  const save = (key: string) =>
    apiKey.mutate(
      { key },
      {
        onSuccess: (signIns) => {
          shown(signIns);
          setPasting(false);
        },
      },
    );
  return (
    <>
      <SettingRow label="Codex" hint={codexHint(codex)}>
        <CodexControls codex={codex} act={act} />
      </SettingRow>
      {pasting && !codex.mode && !codex.signingIn && !codex.pending ? (
        <TokenField
          label="API key"
          placeholder="Paste key"
          hint={
            <>
              Create one in{" "}
              <TextButton underline onClick={() => window.openorc.openExternal(KEYS_URL)}>
                your OpenAI account
              </TextButton>
              .
            </>
          }
          action="Save"
          busy={pending}
          onSave={save}
        />
      ) : null}
      <StillWorks at={remove.isSuccess ? removed : null} />
      <Failure error={error} />
    </>
  );
}

/** This Mac's GitHub sign-in on the brain, switched on here. A blocked switch says why on hover. */
function BrainGitHub({ github, busy }: { github: SignIns["github"]; busy: boolean }) {
  const choose = useRpcMutation("cloud.brain.github");
  const blocked = github.on ? null : github.blocked;
  const toggle = (
    <Switch
      aria-label="GitHub"
      checked={choose.isPending ? choose.variables.on : github.on}
      disabled={choose.isPending || busy || blocked !== null}
      onChange={(e) => choose.mutate({ on: e.target.checked }, { onSuccess: shown })}
    />
  );
  return (
    <SettingRow label="GitHub" hint={github.on ? github.blocked : null}>
      {github.behind ? <Send busy={busy} /> : null}
      {blocked ? <Tooltip label={blocked}>{toggle}</Tooltip> : toggle}
    </SettingRow>
  );
}

/** A key of this Mac's the brain keeps a copy of: its push key, its memory's API key. Shown only once there is one. */
function Handed({ label, handed, busy }: { label: string; handed: SignIns["push"]; busy: boolean }) {
  if (!handed.has && !handed.behind) return null;
  return <SettingRow label={label}>{handed.behind ? <Send busy={busy} /> : <Status ok>On</Status>}</SettingRow>;
}

/** What the brain signs in with besides Claude. `busy` while the brain is at another operation. */
export function CloudBrainSignIns({ active, busy }: { active: boolean; busy: boolean }) {
  const signIns = useRpc("cloud.brain.signIns", {}, { enabled: active });
  if (!signIns.data) return null;
  return (
    <>
      <BrainCodex codex={signIns.data.codex} busy={busy} />
      <BrainGitHub github={signIns.data.github} busy={busy} />
      <Handed label="Notifications" handed={signIns.data.push} busy={busy} />
      <Handed label="Anthropic API key" handed={signIns.data.memory} busy={busy} />
    </>
  );
}
