import { harnessCatalog, openCodeProviderName, SIGN_IN_WAYS, type AccountSignIn, type HostedAgent, type SignInWay, type SignInWork } from "@openorc/protocol";
import { useState } from "react";
import { Button, Input, Select, TextButton } from "../components/ui";
import { useRpc, useRpcMutation } from "../lib/client";
import { COMMON, ProviderChoice, TYPED, useProviders } from "./settings-cloud-opencode";
import { Failure, TokenField } from "./settings-secret-field";
import { Field, SettingRow, Status } from "./settings-shared";

/** What starts each way, as its button says it. */
const WAY_LABELS: Record<SignInWay, (agent: HostedAgent) => string> = {
  token: () => "Sign in with Claude",
  code: () => "Sign in with ChatGPT",
  key: (agent) => (agent === "opencode" ? "Add a key" : "Use an API key"),
};

/** What the person does while a way waits on them. */
const WAITING: Record<"token" | "code", string> = {
  token: "Sign in to Claude in the browser that opened.",
  code: "Enter this code on OpenAI's page.",
};

/**
 * One agent's sign-in on OpenOrc Cloud, drawn from its ways and its state, never from its name: a fourth agent is one
 * entry in SIGN_IN_WAYS.
 *   not connected  a button per way, the first as the row's button, the rest as quiet text
 *   connecting     a token waits on the browser, with Cancel; a device code shows the code, Open page and Cancel
 *   connected      its label (a plan or "API key"), Remove; OpenCode lists a row per provider key
 *   ended          "Signed out", and its ways again
 *   failed         the words for why, and its ways again
 * State: `typing`, whether the key field is open. A key goes to the core once and the field empties.
 */
export function AgentSignInRow({ agent, rows, work }: { agent: HostedAgent; rows: AccountSignIn[]; work: SignInWork | undefined }) {
  const connect = useRpcMutation("account.signIns.connect");
  const cancel = useRpcMutation("account.signIns.cancel");
  const remove = useRpcMutation("account.signIns.remove");
  const claude = useClaudeAccountChoice();
  const [typing, setTyping] = useState(false);
  const busy = connect.isPending || cancel.isPending || remove.isPending;
  const kept = agent === "opencode" ? [] : rows;
  const signedIn = kept.find((row) => !row.ended);
  const start = (way: SignInWay) => {
    if (way === "key") return setTyping(true);
    connect.mutate(way === "token" ? { way, agent: "claude", ...(claude.chosen && { claudeAccountId: claude.chosen }) } : { way, agent: "codex" });
  };
  const controls = () => {
    if (work?.state === "waiting") return <Waiting work={work} busy={busy} onCancel={() => cancel.mutate({ agent })} />;
    if (signedIn)
      return (
        <>
          <Status ok>Ready</Status>
          <TextButton tone="muted" disabled={busy} onClick={() => remove.mutate({ agent })}>
            Remove
          </TextButton>
        </>
      );
    return <Ways agent={agent} ways={SIGN_IN_WAYS[agent]} ended={kept.some((row) => row.ended)} busy={busy} onStart={start} />;
  };
  const choosing = SIGN_IN_WAYS[agent].includes("token") && claude.accounts.length > 1 && !signedIn && work?.state !== "waiting";
  return (
    <>
      <SettingRow label={harnessCatalog[agent].name} hint={hintOf(work, signedIn)}>
        {controls()}
      </SettingRow>
      {choosing ? (
        <Field label="Claude account">
          <Select value={claude.chosen ?? ""} disabled={busy} onChange={(event) => claude.choose(event.target.value)}>
            {claude.accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {agent === "opencode" ? rows.map((row) => <ProviderKey key={row.provider} row={row} busy={busy} onRemove={() => remove.mutate({ agent, provider: row.provider })} />) : null}
      {typing ? (
        <KeyField
          agent={agent}
          taken={rows.map((row) => row.provider)}
          busy={busy}
          onSave={(key, provider) => connect.mutate({ way: "key", agent, key, ...(provider && { provider }) }, { onSuccess: () => setTyping(false) })}
        />
      ) : null}
      <Failure error={connect.error ?? cancel.error ?? remove.error} />
    </>
  );
}

function hintOf(work: SignInWork | undefined, signedIn: AccountSignIn | undefined) {
  if (work?.state === "waiting") return WAITING[work.way];
  if (work?.state === "failed") return <span className="text-bad">{work.error}</span>;
  return signedIn?.label;
}

/** The ways to sign in, the first as the row's button and the rest as quiet text. */
function Ways({ agent, ways, ended, busy, onStart }: { agent: HostedAgent; ways: readonly SignInWay[]; ended: boolean; busy: boolean; onStart: (way: SignInWay) => void }) {
  const [first, ...rest] = ways;
  return (
    <>
      {ended ? <Status>Signed out</Status> : null}
      {rest.map((way) => (
        <TextButton key={way} tone="muted" disabled={busy} onClick={() => onStart(way)}>
          {WAY_LABELS[way](agent)}
        </TextButton>
      ))}
      {first ? (
        <Button disabled={busy} onClick={() => onStart(first)}>
          {WAY_LABELS[first](agent)}
        </Button>
      ) : null}
    </>
  );
}

/** A way that waits on the person: the browser, or a code to enter on the vendor's page. */
function Waiting({ work, busy, onCancel }: { work: Extract<SignInWork, { state: "waiting" }>; busy: boolean; onCancel: () => void }) {
  return (
    <>
      {work.way === "code" ? (
        <>
          <code className="font-mono text-base text-ink select-all">{work.userCode}</code>
          <TextButton tone="muted" onClick={() => void navigator.clipboard.writeText(work.userCode)}>
            Copy
          </TextButton>
          <Button onClick={() => window.openorc.openExternal(work.verificationUrl)}>Open page</Button>
        </>
      ) : (
        <Status>Waiting for sign-in</Status>
      )}
      <Button variant="ghost" disabled={busy} onClick={onCancel}>
        Cancel
      </Button>
    </>
  );
}

/** One OpenCode provider's key on the account. */
function ProviderKey({ row, busy, onRemove }: { row: AccountSignIn; busy: boolean; onRemove: () => void }) {
  return (
    <SettingRow label={openCodeProviderName(row.provider)}>
      <Status ok={!row.ended}>{row.ended ? "Signed out" : "Key saved"}</Status>
      <TextButton tone="muted" disabled={busy} onClick={onRemove}>
        Remove
      </TextButton>
    </SettingRow>
  );
}

/** An API key typed in; for OpenCode, the provider it is for first, this Mac's own providers leading. */
function KeyField({ agent, taken, busy, onSave }: { agent: HostedAgent; taken: string[]; busy: boolean; onSave: (key: string, provider: string | undefined) => void }) {
  const names = useProviders();
  const [picked, setPicked] = useState("");
  const [typed, setTyped] = useState("");
  const open = (id: string) => !taken.includes(id);
  const here = [...names].filter(([id]) => open(id));
  const others = COMMON.filter((id) => open(id) && !names.has(id)).map((id): [string, string] => [id, openCodeProviderName(id)]);
  const choice = picked || here[0]?.[0] || others[0]?.[0] || TYPED;
  const named = choice === TYPED ? typed : choice;
  const provider = agent === "opencode" ? named : undefined;
  return (
    <>
      {agent === "opencode" ? (
        <SettingRow label="Provider">
          <ProviderChoice here={here} others={others} value={choice} onChange={setPicked} />
        </SettingRow>
      ) : null}
      {agent === "opencode" && choice === TYPED ? (
        <SettingRow label="Provider name">
          <Input value={typed} placeholder="As in a model id, like togetherai" spellCheck={false} onChange={(event) => setTyped(event.target.value.trim().toLowerCase())} />
        </SettingRow>
      ) : null}
      <TokenField label="API key" placeholder="Paste key" hint={undefined} action="Save" busy={busy || (agent === "opencode" && !provider)} onSave={(key) => onSave(key, provider)} />
    </>
  );
}

/** The Claude account of this Mac that makes the token, offered when there is more than one; the default first. */
function useClaudeAccountChoice(): { accounts: { id: string; name: string }[]; chosen: string | null; choose: (id: string) => void } {
  const list = useRpc("claude.accounts.list", {});
  const [chosen, choose] = useState<string | null>(null);
  const accounts = (list.data?.accounts ?? []).filter((account) => account.enabled).map(({ id, name }) => ({ id, name }));
  return { accounts, chosen: chosen ?? list.data?.defaultId ?? null, choose };
}
