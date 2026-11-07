import { useState } from "react";
import type { ClaudeAccountConnection, ClaudeAccounts, Project, ProjectClaudeAccounts } from "@openorc/protocol";
import { Button, Checkbox, Field, Input, Textarea, TextButton } from "../components/ui";
import { queryClient, useRpc, useRpcMutation } from "../lib/client";
import { accountMeta, connectionLabels } from "./settings-claude-accounts";
import { Status, Toggle } from "./settings-shared";

/** What the repository already says about itself: its default branch, remote and other tools' config files. */
function ProjectFacts({ project: p }: { project: Project }) {
  const facts = [
    { label: "Default branch", value: p.defaultBranch ?? "unknown" },
    ...(p.gitRemote ? [{ label: "Remote", value: p.gitRemote }] : []),
    ...(p.settings.detectedConfigs.length > 0 ? [{ label: "Found", value: p.settings.detectedConfigs.join(", ") }] : []),
  ];
  return (
    <dl className="mb-5 grid gap-1 text-sm">
      {facts.map((fact) => (
        <div key={fact.label} className="flex min-w-0 gap-3">
          <dt className="w-28 shrink-0 text-ink-4">{fact.label}</dt>
          <dd className="min-w-0 truncate font-mono text-ink-2">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Worktree settings for a project's tasks, in one card. Saving says so in place until the next edit. */
export function ProjectSettings({ projectId }: { projectId: string }) {
  const project = useRpc("projects.get", { id: projectId });
  const update = useRpcMutation("projects.updateSettings");
  const p = project.data;
  const [setupScript, setSetupScript] = useState<string | null>(null);
  const [include, setInclude] = useState<string | null>(null);
  const [prefix, setPrefix] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  if (!p) return null;
  const s = p.settings;
  const edit = (set: (value: string) => void) => (value: string) => {
    setSaved(false);
    set(value);
  };
  const save = () =>
    update.mutate(
      {
        id: p.id,
        settings: {
          branchPrefix: (prefix ?? s.branchPrefix).trim() || "openorc",
          worktreeInclude: (include ?? s.worktreeInclude.join("\n"))
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean),
          setupScript: (setupScript ?? s.setupScript ?? "").trim() || null,
        },
      },
      {
        onSuccess: () => {
          setPrefix(null);
          setInclude(null);
          setSetupScript(null);
          setSaved(true);
        },
      },
    );

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="w-full max-w-2xl px-6 pt-4 pb-10">
        <section data-plane aria-label="Project settings" className="rounded-3xl bg-surface p-5">
          <ProjectFacts project={p} />
          <Field label="Branch prefix" hint="Task branches are named prefix/slug-id.">
            <Input value={prefix ?? s.branchPrefix} onChange={(e) => edit(setPrefix)(e.target.value)} />
          </Field>
          <Field label="Copy these gitignored files into new worktrees" hint="One pattern per line, gitignore syntax. .env files by default.">
            <Textarea rows={3} className="font-mono" value={include ?? s.worktreeInclude.join("\n")} onChange={(e) => edit(setInclude)(e.target.value)} />
          </Field>
          <Field label="Setup script" hint="Runs in the new worktree before the agent starts. OPENORC_PORT, OPENORC_WORKSPACE_PATH, and OPENORC_ROOT_PATH are set.">
            <Textarea rows={4} className="font-mono" placeholder="pnpm install --frozen-lockfile" value={setupScript ?? s.setupScript ?? ""} onChange={(e) => edit(setSetupScript)(e.target.value)} />
          </Field>
          <div className="mt-5 flex items-center justify-end gap-3">
            <span role="status" className="text-sm text-ink-4">
              {saved ? <span className="motion-arrive inline-block">Saved</span> : null}
            </span>
            <Button variant="primary" size="lg" disabled={update.isPending} onClick={save}>
              Save settings
            </Button>
          </div>
          {update.error ? <p className="mt-2 text-sm text-bad">{update.error.message}</p> : null}
        </section>
        <ProjectClaudeAccountsSection project={p} />
      </div>
    </div>
  );
}

/**
 * Turning the project's own accounts on: the selection it kept while they were off, less accounts removed since, or
 * else the app's default account; its switch at usage limits as kept, or else as the app's is now.
 */
function turnedOn(saved: ProjectClaudeAccounts | null | undefined, list: ClaudeAccounts, appAutoSwitch: boolean): ProjectClaudeAccounts {
  const known = new Set(list.accounts.map((account) => account.id));
  const kept = (saved?.accountIds ?? []).filter((id) => known.has(id));
  const fallback = known.has(list.defaultId) ? list.defaultId : list.accounts.find((account) => account.enabled)?.id;
  const accountIds = kept.length ? kept : [fallback].filter((id) => id !== undefined);
  return { only: true, accountIds, defaultId: defaultAmong(accountIds, saved?.defaultId), autoSwitch: saved ? saved.autoSwitch : appAutoSwitch };
}

/** The default while it is one of the accounts, else the first of them. */
function defaultAmong(accountIds: readonly string[], defaultId: string | null | undefined): string | null {
  return defaultId && accountIds.includes(defaultId) ? defaultId : (accountIds[0] ?? null);
}

/** The selection less accounts removed since, which the host would refuse in any change; the default moves with them. */
function withoutRemoved(own: ProjectClaudeAccounts, accounts: readonly ClaudeAccountConnection[]): ProjectClaudeAccounts {
  const known = new Set(accounts.map((account) => account.id));
  const accountIds = own.accountIds.filter((id) => known.has(id));
  return { ...own, accountIds, defaultId: defaultAmong(accountIds, own.defaultId) };
}

/** One account in or out of the selection; the default moves to the first one left when it goes. */
function withAccount(own: ProjectClaudeAccounts, id: string, chosen: boolean): ProjectClaudeAccounts {
  const accountIds = chosen ? [...new Set([...own.accountIds, id])] : own.accountIds.filter((each) => each !== id);
  return { ...own, accountIds, defaultId: defaultAmong(accountIds, own.defaultId) };
}

/** Saves each change at once, showing it before the host answers; a refused change goes back, saying why. */
function useProjectAccountsSave(project: Project) {
  const update = useRpcMutation("projects.updateSettings");
  const [draft, setDraft] = useState<ProjectClaudeAccounts | null>(null);
  const save = (next: ProjectClaudeAccounts) => {
    setDraft(next);
    update.mutate(
      { id: project.id, settings: { claudeAccounts: next } },
      {
        onSuccess: (saved) => {
          queryClient.setQueryData(["projects.get", { id: project.id }], saved);
          setDraft(null);
        },
        onError: () => setDraft(null),
      },
    );
  };
  return { value: draft ?? project.settings.claudeAccounts ?? null, save, pending: update.isPending, error: update.error };
}

/** Which Claude accounts the project's threads use: the app's, or only those chosen here, with their own default and switch. */
function ProjectClaudeAccountsSection({ project }: { project: Project }) {
  const list = useRpc("claude.accounts.list", {});
  const appAutoSwitch = useRpc("app.settings.get", {}).data?.claudeAccountAutoSwitch ?? false;
  const { value, save, pending, error } = useProjectAccountsSave(project);
  const only = Boolean(value?.only);
  const appSetting = appAutoSwitch ? "On" : "Off";
  return (
    <section className="settings-section project-accounts" aria-labelledby="project-accounts-title">
      <header className="settings-section-intro">
        <h2 id="project-accounts-title">Claude accounts</h2>
        <p>Choose which accounts threads in this project can use. Other projects keep the app&apos;s accounts.</p>
      </header>
      <div className="settings-section-body settings-group">
        <Toggle
          label="Use only selected accounts"
          hint={
            only
              ? `Threads in ${project.name} start, switch and continue on these accounts only.`
              : `Off. Threads use any enabled account, and switching at usage limits follows the app setting (${appSetting}).`
          }
          checked={only}
          disabled={pending || !list.data}
          onChange={(on) => list.data && save(on ? turnedOn(value, list.data, appAutoSwitch) : { ...value!, only: false })}
        />
        {only && value && list.data ? <ChosenAccounts own={withoutRemoved(value, list.data.accounts)} accounts={list.data.accounts} appSetting={appSetting} pending={pending} onChange={save} /> : null}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-bad">
          {error.message}
        </p>
      ) : null}
    </section>
  );
}

function ChosenAccounts({
  own,
  accounts,
  appSetting,
  pending,
  onChange,
}: {
  own: ProjectClaudeAccounts;
  accounts: ClaudeAccountConnection[];
  appSetting: string;
  pending: boolean;
  onChange: (next: ProjectClaudeAccounts) => void;
}) {
  // A disabled account stays listed while it is chosen, so it can be taken out.
  const shown = accounts.filter((account) => account.enabled || own.accountIds.includes(account.id));
  const usable = accounts.filter((account) => account.enabled && own.accountIds.includes(account.id)).length;
  return (
    <>
      {shown.map((account) => {
        const chosen = own.accountIds.includes(account.id);
        return (
          <div key={account.id} className="settings-field project-account">
            <label className="project-account-choice">
              {/* The last account chosen stays chosen: a project that uses only some accounts needs one. */}
              <Checkbox checked={chosen} disabled={pending || (chosen && own.accountIds.length === 1)} onChange={(event) => onChange(withAccount(own, account.id, event.target.checked))} />
              <span className="project-account-name">
                <span>{account.name}</span>
                <span className="settings-hint">{accountMeta(account)}</span>
              </span>
            </label>
            <div className="project-account-state">
              {chosen && account.enabled && own.defaultId === account.id ? <span className="settings-card-tag">Default</span> : null}
              {chosen && account.enabled && own.defaultId !== account.id ? (
                <TextButton tone="muted" className="text-xs" disabled={pending} onClick={() => onChange({ ...own, defaultId: account.id })}>
                  Make default
                </TextButton>
              ) : null}
              <Status ok={account.status === "ready"}>{connectionLabels[account.status]}</Status>
            </div>
          </div>
        );
      })}
      <Toggle
        label="Switch accounts at usage limits"
        hint={
          usable < 2
            ? "Select two or more accounts to switch"
            : `When a thread's account reaches its limit, it continues on the selected account with the most 5-hour usage left. Overrides the app setting (${appSetting}).`
        }
        checked={own.autoSwitch}
        disabled={pending || usable < 2}
        onChange={(autoSwitch) => onChange({ ...own, autoSwitch })}
      />
    </>
  );
}
