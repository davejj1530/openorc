import { useState, type ReactNode } from "react";
import type { CodexCloudAccess } from "@openorc/protocol";
import { Button, TextButton } from "../components/ui";
import { useRpcMutation } from "../lib/client";
import { Section, SettingRow, Status } from "./settings-shared";
import { Failure, StillWorks, TokenField, type RevokedAt } from "./settings-secret-field";
import { ThisComputer, thisComputer } from "../lib/this-computer";

const KEYS_URL = "https://platform.openai.com/api-keys";

/** Who a Codex login belongs to, in a few words. */
export function codexWho(codex: Pick<CodexCloudAccess, "mode" | "email" | "plan">): string {
  if (codex.mode === "apiKey") return "An OpenAI API key, billed by the token";
  return [codex.email, codex.plan ? `ChatGPT ${codex.plan[0]!.toUpperCase()}${codex.plan.slice(1)}` : null].filter(Boolean).join(" · ") || "Signed in with ChatGPT";
}

/** Whether any of a login's mutations runs, and the first error among them, else the login's own. */
export function together(mutations: { isPending: boolean; error: Error | null }[], own: string | null): { busy: boolean; error: Error | null } {
  const failed = mutations.find((mutation) => mutation.error)?.error;
  return { busy: mutations.some((mutation) => mutation.isPending), error: failed ?? (own ? new Error(own) : null) };
}

/** Where an OpenAI API key for Codex is pasted, with the way to make one. */
export function OpenAIKeyField({ busy, onSave }: { busy: boolean; onSave: (key: string) => void }) {
  return (
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
      busy={busy}
      onSave={onSave}
    />
  );
}

function hint(codex: CodexCloudAccess): string {
  if (codex.signingIn) return "Sign in to ChatGPT in the browser that opened.";
  return codex.mode ? codexWho(codex) : "Your ChatGPT plan, or an API key";
}

type Mutations = { signIn: () => void; cancel: () => void; remove: () => void; paste: () => void; busy: boolean };

/** Waiting for the browser, ready with a way to sign in again or remove it, or the two ways to sign in. */
function Controls({ codex, act }: { codex: CodexCloudAccess; act: Mutations }) {
  if (codex.signingIn)
    return (
      <>
        <Status>Waiting for sign-in</Status>
        <Button variant="ghost" disabled={act.busy} onClick={act.cancel}>
          Cancel
        </Button>
      </>
    );
  if (codex.mode)
    return (
      <>
        <Status ok>Ready</Status>
        {codex.mode === "chatgpt" ? (
          <TextButton tone="muted" disabled={act.busy} onClick={act.signIn}>
            Sign in again
          </TextButton>
        ) : null}
        <TextButton tone="muted" disabled={act.busy} onClick={act.remove}>
          Remove
        </TextButton>
      </>
    );
  return (
    <>
      <Button disabled={act.busy} onClick={act.signIn}>
        Sign in with ChatGPT
      </Button>
      <TextButton tone="muted" disabled={act.busy} onClick={act.paste}>
        Use an API key
      </TextButton>
    </>
  );
}

const ALONE = `Codex signs in to sandboxes with a ChatGPT sign-in of its own, never ${thisComputer}'s, or an API key.`;
/** Why there are two rows once there is a cloud brain: a ChatGPT login's refresh works in one place. */
const WITH_BRAIN = `A ChatGPT sign-in works in one place at a time, so ${thisComputer}'s cloud threads and the cloud brain each need their own. An API key works for both.`;

/**
 * How Codex signs in to sandboxes: a ChatGPT sign-in of its own, so a sandbox never shares this Mac's login, or an
 * OpenAI API key. With a cloud brain, `brain` is its own login's row, under this one.
 */
export function CodexCloudSection({ codex, brain }: { codex: CodexCloudAccess; brain?: ReactNode }) {
  const signIn = useRpcMutation("cloud.codex.signIn");
  const cancel = useRpcMutation("cloud.codex.cancel");
  const apiKey = useRpcMutation("cloud.codex.apiKey");
  const remove = useRpcMutation("cloud.codex.remove");
  const [pasting, setPasting] = useState(false);
  /** The kind of sign-in last removed, until another is begun. */
  const [removed, setRemoved] = useState<RevokedAt | null>(null);
  const { busy, error } = together([signIn, cancel, apiKey, remove], codex.error);
  const act: Mutations = {
    busy,
    signIn: () => {
      setRemoved(null);
      signIn.mutate({});
    },
    cancel: () => cancel.mutate({}),
    remove: () => {
      setRemoved(codex.mode);
      remove.mutate({});
    },
    paste: () => {
      setRemoved(null);
      setPasting(!pasting);
    },
  };
  return (
    <Section title="Codex" description={brain ? WITH_BRAIN : ALONE}>
      <SettingRow label={brain ? `${ThisComputer}'s cloud threads` : "Sign-in"} hint={hint(codex)}>
        <Controls codex={codex} act={act} />
      </SettingRow>
      {pasting && !codex.mode && !codex.signingIn ? <OpenAIKeyField busy={busy} onSave={(key) => apiKey.mutate({ key }, { onSuccess: () => setPasting(false) })} /> : null}
      <StillWorks at={remove.isSuccess && !codex.mode ? removed : null} />
      <Failure error={error} />
      {brain}
    </Section>
  );
}
