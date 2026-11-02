import { useState } from "react";
import type { CodexCloudAccess } from "@openorc/protocol";
import { Button, TextButton } from "../components/ui";
import { useRpcMutation } from "../lib/client";
import { Section, SettingRow, Status } from "./settings-shared";
import { Failure, TokenField } from "./settings-secret-field";

const KEYS_URL = "https://platform.openai.com/api-keys";

function who(codex: CodexCloudAccess): string {
  if (codex.mode === "apiKey") return "An OpenAI API key, billed by the token";
  return [codex.email, codex.plan ? `ChatGPT ${codex.plan[0]!.toUpperCase()}${codex.plan.slice(1)}` : null].filter(Boolean).join(" · ") || "Signed in with ChatGPT";
}

function hint(codex: CodexCloudAccess): string {
  if (codex.signingIn) return "Sign in to ChatGPT in the browser that opened.";
  return codex.mode ? who(codex) : "Your ChatGPT plan, or an API key";
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

/**
 * How Codex signs in to sandboxes: a ChatGPT sign-in of its own, so a sandbox never shares this Mac's login, or an
 * OpenAI API key.
 */
export function CodexCloudSection({ codex }: { codex: CodexCloudAccess }) {
  const signIn = useRpcMutation("cloud.codex.signIn");
  const cancel = useRpcMutation("cloud.codex.cancel");
  const apiKey = useRpcMutation("cloud.codex.apiKey");
  const remove = useRpcMutation("cloud.codex.remove");
  const [pasting, setPasting] = useState(false);
  const busy = signIn.isPending || cancel.isPending || apiKey.isPending || remove.isPending;
  const act: Mutations = { busy, signIn: () => signIn.mutate({}), cancel: () => cancel.mutate({}), remove: () => remove.mutate({}), paste: () => setPasting(!pasting) };
  const error = signIn.error ?? cancel.error ?? apiKey.error ?? remove.error ?? (codex.error ? new Error(codex.error) : null);
  return (
    <Section title="Codex" description="Codex signs in to sandboxes with a sign-in of its own, never this Mac's.">
      <SettingRow label="Sign-in" hint={hint(codex)}>
        <Controls codex={codex} act={act} />
      </SettingRow>
      {pasting && !codex.mode && !codex.signingIn ? (
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
          onSave={(key) => apiKey.mutate({ key }, { onSuccess: () => setPasting(false) })}
        />
      ) : null}
      <Failure error={error} />
    </Section>
  );
}
