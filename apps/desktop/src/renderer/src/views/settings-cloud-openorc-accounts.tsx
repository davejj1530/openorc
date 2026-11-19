import { Menu } from "@base-ui/react/menu";
import {
  harnessCatalog,
  openCodeProviderName,
  percentLeft,
  sessionWindow,
  SIGN_IN_WAYS,
  weeklyWindow,
  type AccountSignIn,
  type AllowanceWindow,
  type HostedAgent,
  type SignInWay,
  type SignInWork,
} from "@openorc/protocol";
import { usageResetLabel } from "@openorc/client";
import { useState } from "react";
import { useNow } from "../components/AccountUsage";
import { AmountShare } from "../components/ContextUsage";
import { HarnessLogo } from "../components/HarnessLogo";
import { ChevronDown, MoreHorizontal, Plus } from "../components/icons";
import { menuItem, menuPopup, menuSeparator } from "../components/menu";
import { Button, IconButton, Input, Select, TextButton } from "../components/ui";
import { USAGE_MAX_AGE_MS } from "../lib/account-usage-data";
import { CoversPreview } from "../lib/browser-preview";
import { useRpc, useRpcMutation } from "../lib/client";
import { cn } from "../lib/cn";
import { floatingGround } from "../lib/use-anchor-ground";
import { COMMON, ProviderChoice, TYPED, useProviders } from "./settings-cloud-openorc-providers";
import { useClaudeAccountChoice, Waiting, WAITING, WAY_LABELS } from "./settings-cloud-openorc-sign-ins";
import { Status } from "./settings-shared";
import "./settings-claude-accounts.css";
import "./settings-cloud-openorc-accounts.css";

/** The agents whose CLIs report their limits after a cloud turn. */
const LIMITED = new Set<HostedAgent>(["claude", "codex"]);

type Account = AccountSignIn & { id: string };

/**
 * One agent's accounts on OpenOrc Cloud, where the server keeps several: each account with its plan, Default, and its
 * limits as the agent last read them, then a new one to add. With none yet, the ways to add the first stand open.
 * A sign-in under way shows on the account it signs in again, or where a new one is added.
 */
export function AgentAccounts({ agent, rows, work }: { agent: HostedAgent; rows: AccountSignIn[]; work: SignInWork | undefined }) {
  const name = harnessCatalog[agent].name;
  return (
    <div className="settings-account-list" data-plane role="group" aria-label={name}>
      <div className="settings-account-row">
        <h3 className="settings-agent-title">
          <HarnessLogo id={agent} size={16} />
          {name}
        </h3>
      </div>
      {rows
        .filter((row): row is Account => row.id !== undefined)
        .map((row) => (
          <CloudAccountRow key={row.id} row={row} work={work?.accountId === row.id ? work : undefined} />
        ))}
      <NewAccount agent={agent} first={rows.length === 0} work={work && !work.accountId ? work : undefined} />
    </div>
  );
}

/**
 * One account: its name and Default, its plan (for OpenCode, its provider) and limits, whether it is signed in, and
 * the menu to make it the default, rename it, sign it in again or remove it.
 * State: `renaming`, the name field open; `again`, signing in again asks something first (a key, or which of this
 * Mac's Claude accounts makes the token).
 */
function CloudAccountRow({ row, work }: { row: Account; work: SignInWork | undefined }) {
  const { id } = row;
  const name = row.name ?? row.label;
  const connect = useRpcMutation("account.signIns.connect");
  const cancel = useRpcMutation("account.signIns.cancel");
  const update = useRpcMutation("account.signIns.update");
  const remove = useRpcMutation("account.signIns.remove");
  const claude = useClaudeAccountChoice();
  const [renaming, setRenaming] = useState(false);
  const [again, setAgain] = useState(false);
  const busy = connect.isPending || cancel.isPending || update.isPending || remove.isPending;
  const way = row.way ?? "key";
  const signInAgain = () => {
    if (way === "key" || (way === "token" && claude.accounts.length > 1)) return setAgain(true);
    connect.mutate(way === "token" ? { way, agent: "claude", accountId: id } : { way: "code", agent: "codex", accountId: id });
  };
  const waiting = work?.state === "waiting" ? work : null;
  const failure = work?.state === "failed" ? work.error : [connect, cancel, update, remove].find((mutation) => mutation.error)?.error?.message;
  return (
    <div className="settings-account-row settings-cloud-account" data-waiting={waiting ? "" : undefined} role="group" aria-label={name}>
      <AccountSummary row={row} name={name} waiting={waiting} />
      <div className="settings-account-actions">
        {waiting ? (
          <Waiting work={waiting} busy={busy} onCancel={() => cancel.mutate({ agent: row.agent })} />
        ) : (
          <>
            <SignedOut row={row} busy={busy} asking={again} onAgain={signInAgain} />
            <AccountMenu
              row={row}
              name={name}
              busy={busy}
              onDefault={() => update.mutate({ accountId: id, isDefault: true })}
              onRename={() => setRenaming(true)}
              onAgain={signInAgain}
              onRemove={() => remove.mutate({ agent: row.agent, accountId: id })}
            />
          </>
        )}
      </div>
      {renaming ? (
        <RenameForm name={name} busy={busy} onSave={(next) => update.mutate({ accountId: id, name: next }, { onSuccess: () => setRenaming(false) })} onCancel={() => setRenaming(false)} />
      ) : null}
      {again ? (
        <AgainForm row={row} claude={claude} busy={busy} onSave={(input) => connect.mutate({ ...input, accountId: id }, { onSuccess: () => setAgain(false) })} onCancel={() => setAgain(false)} />
      ) : null}
      {failure ? (
        <p className="settings-account-feedback text-bad" role="alert">
          {failure}
        </p>
      ) : null}
    </div>
  );
}

/** An account's name and Default, then its plan (unless that is its name) or what a sign-in under way waits on, then its limits. */
function AccountSummary({ row, name, waiting }: { row: Account; name: string; waiting: Extract<SignInWork, { state: "waiting" }> | null }) {
  const plan = planOf(row);
  const meta = waiting ? WAITING[waiting.way] : plan !== name && plan;
  return (
    <div className="min-w-0">
      <div className="settings-account-title">
        <span>{name}</span>
        {row.isDefault ? <span className="settings-account-default">Default</span> : null}
      </div>
      {meta ? <p className="settings-account-meta">{meta}</p> : null}
      {LIMITED.has(row.agent) && !row.ended ? <AccountLimits agent={row.agent} accountId={row.id} /> : null}
    </div>
  );
}

/** A signed-out account says so, with Sign in again until that asks its question below. */
function SignedOut({ row, busy, asking, onAgain }: { row: Account; busy: boolean; asking: boolean; onAgain: () => void }) {
  if (!row.ended) return null;
  return (
    <>
      <Status>Signed out</Status>
      {asking ? null : (
        <Button size="sm" disabled={busy} onClick={onAgain}>
          Sign in again
        </Button>
      )}
    </>
  );
}

/** An account's menu: make it the default, rename it, sign it in again while it is signed in, remove it. */
function AccountMenu({
  row,
  name,
  busy,
  onDefault,
  onRename,
  onAgain,
  onRemove,
}: {
  row: Account;
  name: string;
  busy: boolean;
  onDefault: () => void;
  onRename: () => void;
  onAgain: () => void;
  onRemove: () => void;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger render={<IconButton aria-label={`More for ${name}`} size="sm" />}>
        <MoreHorizontal size={16} />
      </Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner sideOffset={6} align="end" className="z-40" collisionPadding={8}>
          <Menu.Popup ref={floatingGround} className={menuPopup}>
            {row.isDefault ? null : (
              <Menu.Item className={menuItem} disabled={busy} onClick={onDefault}>
                Make default
              </Menu.Item>
            )}
            <Menu.Item className={menuItem} disabled={busy} onClick={onRename}>
              Rename
            </Menu.Item>
            {row.ended ? null : (
              <Menu.Item className={menuItem} disabled={busy} onClick={onAgain}>
                Sign in again
              </Menu.Item>
            )}
            <Menu.Separator className={menuSeparator} />
            <Menu.Item className={menuItem} disabled={busy} onClick={onRemove}>
              Remove
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** Signing an account in again when that asks something first: its key, or which of this Mac's Claude accounts makes the token. */
function AgainForm({
  row,
  claude,
  busy,
  onSave,
  onCancel,
}: {
  row: Account;
  claude: ReturnType<typeof useClaudeAccountChoice>;
  busy: boolean;
  onSave: (input: { way: "key"; agent: HostedAgent; key: string; provider?: string } | { way: "token"; agent: "claude"; claudeAccountId?: string }) => void;
  onCancel: () => void;
}) {
  return (
    <div className="settings-account-form settings-account-rename">
      {row.way === "token" ? (
        <>
          <ClaudeAccountField choice={claude} busy={busy} />
          <Button size="lg" disabled={busy} onClick={() => onSave({ way: "token", agent: "claude", ...(claude.chosen && { claudeAccountId: claude.chosen }) })}>
            {WAY_LABELS.token(row.agent)}
          </Button>
        </>
      ) : (
        <KeyFields agent={row.agent} provider={row.provider} busy={busy} onSave={(key, provider) => onSave({ way: "key", agent: row.agent, key, ...(provider && { provider }) })} />
      )}
      <Button size="lg" variant="ghost" disabled={busy} onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

/** What an account is: its plan or "API key", and for OpenCode its provider. */
function planOf(row: Account): string {
  return row.agent === "opencode" ? openCodeProviderName(row.provider) : row.label;
}

/** An account's 5-hour and weekly limits as its agent last read them on a cloud turn; nothing before the first reading. */
function AccountLimits({ agent, accountId }: { agent: HostedAgent; accountId: string }) {
  const usage = useRpc("providers.usage", { provider: agent, cloud: true, cloudAccountId: accountId }, { staleTime: USAGE_MAX_AGE_MS });
  const now = useNow();
  const windows = usage.data?.windows ?? [];
  const limits = [
    { label: "5 hours", window: sessionWindow(windows) },
    { label: "Week", window: weeklyWindow(windows) },
  ].filter((limit): limit is { label: string; window: AllowanceWindow } => limit.window !== null && percentLeft(limit.window) !== null);
  if (!limits.length) return null;
  return (
    <p className="settings-account-meta flex flex-wrap items-center gap-x-3 gap-y-1">
      {limits.map(({ label, window }) => (
        <LimitLeft key={label} label={label} window={window} now={now} />
      ))}
    </p>
  );
}

/** One limit: a ring and the share left, or, used up, when it comes back. */
function LimitLeft({ label, window, now }: { label: string; window: AllowanceWindow; now: number }) {
  const left = percentLeft(window) ?? 0;
  const out = window.exhausted || left <= 0;
  const back = window.resetsAt !== null && window.resetsAt > now ? usageResetLabel(window.resetsAt, now) : null;
  return (
    <span className={cn("inline-flex items-center gap-1.5 tabular-nums", out && "text-warn")}>
      <AmountShare fraction={left / 100} size={14} />
      {out ? [`${label} used up`, back].filter(Boolean).join(" · ") : `${label} ${Math.round(left)}% left`}
    </span>
  );
}

/**
 * Adding an account: an optional name (the plan's, numbered, when none), for OpenCode its provider, and for a Claude
 * token which of this Mac's Claude accounts makes it, then the agent's ways. Folded under Add account once the agent
 * has one; open while it has none. A sign-in for a new account under way stands here until it lands.
 */
function NewAccount({ agent, first, work }: { agent: HostedAgent; first: boolean; work: SignInWork | undefined }) {
  const cancel = useRpcMutation("account.signIns.cancel");
  if (work?.state === "waiting")
    return (
      <div className="settings-account-row">
        <div className="min-w-0">
          <div className="settings-account-title">New account</div>
          <p className="settings-account-meta">{WAITING[work.way]}</p>
        </div>
        <div className="settings-account-actions">
          <Waiting work={work} busy={cancel.isPending} onCancel={() => cancel.mutate({ agent })} />
        </div>
      </div>
    );
  const failure = work?.state === "failed" ? work.error : null;
  if (first)
    return (
      <div className="pt-4">
        <AddForm agent={agent} failure={failure} />
      </div>
    );
  return (
    <details className="settings-account-add" open={failure ? true : undefined}>
      <summary aria-label={`Add ${harnessCatalog[agent].name} account`}>
        <Plus size={16} />
        <span>Add account</span>
        <ChevronDown size={14} className="settings-agent-chevron" />
      </summary>
      <AddForm agent={agent} failure={failure} />
    </details>
  );
}

function AddForm({ agent, failure }: { agent: HostedAgent; failure: string | null }) {
  const connect = useRpcMutation("account.signIns.connect");
  const claude = useClaudeAccountChoice();
  const ways = SIGN_IN_WAYS[agent];
  const keyOnly = ways.length === 1;
  const [name, setName] = useState("");
  const [keyed, setKeyed] = useState(keyOnly);
  const busy = connect.isPending;
  const landing = name.trim() ? { name: name.trim() } : {};
  // A token made as one of several Mac accounts names the new account after it, unless the person names it.
  const signsFrom =
    !keyed && ways.includes("token") && claude.accounts.length > 1
      ? claude.accounts
          .find((account) => account.id === claude.chosen)
          ?.name.slice(0, 40)
          .trim()
      : undefined;
  const tokenLanding = name.trim() || !signsFrom ? landing : { name: signsFrom };
  const done = () => {
    setName("");
    setKeyed(keyOnly);
  };
  const start = (way: SignInWay) => {
    if (way === "key") return setKeyed(true);
    connect.mutate(way === "token" ? { way, agent: "claude", ...tokenLanding, ...(claude.chosen && { claudeAccountId: claude.chosen }) } : { way: "code", agent: "codex", ...landing }, {
      onSuccess: done,
    });
  };
  const [lead, ...rest] = ways;
  const error = failure ?? connect.error?.message;
  return (
    <div className="settings-account-form">
      <label className="settings-account-label">
        Name
        <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={40} placeholder={signsFrom || "Work, Personal, Client…"} disabled={busy} />
      </label>
      {keyed ? (
        <>
          <KeyFields agent={agent} busy={busy} onSave={(key, provider) => connect.mutate({ way: "key", agent, key, ...landing, ...(provider && { provider }) }, { onSuccess: done })} />
          {keyOnly ? null : (
            <Button size="lg" variant="ghost" disabled={busy} onClick={() => setKeyed(false)}>
              Cancel
            </Button>
          )}
        </>
      ) : (
        <>
          {ways.includes("token") ? <ClaudeAccountField choice={claude} busy={busy} /> : null}
          {lead ? (
            <Button size="lg" disabled={busy} onClick={() => start(lead)}>
              {WAY_LABELS[lead](agent)}
            </Button>
          ) : null}
          {rest.map((way) => (
            <TextButton key={way} tone="muted" className="h-8" disabled={busy} onClick={() => start(way)}>
              {WAY_LABELS[way](agent)}
            </TextButton>
          ))}
        </>
      )}
      {error ? (
        <p className="settings-account-feedback mt-0 w-full text-bad" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * An API key, typed once: it goes to the core and the field empties. For OpenCode, the provider it is for, this Mac's
 * own first, unless the account already names one.
 */
function KeyFields({ agent, provider: named, busy, onSave }: { agent: HostedAgent; provider?: string; busy: boolean; onSave: (key: string, provider: string | undefined) => void }) {
  const names = useProviders();
  const [picked, setPicked] = useState("");
  const [typed, setTyped] = useState("");
  const [key, setKey] = useState("");
  const choosing = agent === "opencode" && !named;
  const here = [...names];
  const others = COMMON.filter((id) => !names.has(id)).map((id): [string, string] => [id, openCodeProviderName(id)]);
  const choice = picked || here[0]?.[0] || others[0]?.[0] || TYPED;
  const provider = agent === "opencode" ? (named ?? (choice === TYPED ? typed : choice)) : undefined;
  return (
    <>
      {choosing ? (
        <label className="settings-account-label">
          Provider
          <ProviderChoice here={here} others={others} value={choice} onChange={setPicked} />
        </label>
      ) : null}
      {choosing && choice === TYPED ? (
        <label className="settings-account-label">
          Provider name
          <Input value={typed} placeholder="As in a model id, like togetherai" spellCheck={false} onChange={(event) => setTyped(event.target.value.trim().toLowerCase())} />
        </label>
      ) : null}
      <label className="settings-account-label">
        API key
        <Input type="password" autoComplete="off" spellCheck={false} value={key} disabled={busy} placeholder="Paste key" onChange={(event) => setKey(event.target.value)} />
      </label>
      <Button
        size="lg"
        disabled={busy || !key.trim() || (agent === "opencode" && !provider)}
        onClick={() => {
          onSave(key.trim(), provider);
          setKey("");
        }}
      >
        Save
      </Button>
    </>
  );
}

/** Which of this Mac's Claude accounts signs a cloud account in, by its name, asked only when the Mac has more than one. */
function ClaudeAccountField({ choice, busy }: { choice: ReturnType<typeof useClaudeAccountChoice>; busy: boolean }) {
  if (choice.accounts.length < 2) return null;
  return (
    <label className="settings-account-label">
      Sign in from
      <Select value={choice.chosen ?? ""} disabled={busy} onChange={(event) => choice.choose(event.target.value)}>
        {choice.accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.name}
          </option>
        ))}
      </Select>
    </label>
  );
}

function RenameForm({ name: was, busy, onSave, onCancel }: { name: string; busy: boolean; onSave: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(was);
  return (
    <form
      className="settings-account-form settings-account-rename"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() && !busy) onSave(name.trim());
      }}
    >
      <label className="settings-account-label">
        Name
        <Input aria-label={`Name for ${was}`} value={name} onChange={(event) => setName(event.target.value)} maxLength={40} autoFocus required />
      </label>
      <Button size="lg" type="submit" disabled={!name.trim() || busy}>
        Save name
      </Button>
      <Button size="lg" variant="ghost" disabled={busy} onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}
