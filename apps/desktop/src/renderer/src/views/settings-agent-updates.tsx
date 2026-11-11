import { agentUpdateStatus, agentConnectionStatus } from "./settings-presentation";
import { useState, type ReactNode } from "react";
import {
  agentUpdateNoticeKey,
  harnessCatalog,
  harnessFailsToStart,
  harnessIds,
  harnessInstalled,
  harnessLoggedIn,
  type AgentUpdate,
  type HarnessId,
  type HarnessInfo,
  type SystemInfo,
} from "@openorc/protocol";
import { CoversPreview } from "../lib/browser-preview";
import { cn } from "../lib/cn";
import { useRpc, useRpcMutation } from "../lib/client";
import { useEnabledHarnesses } from "../lib/enabled-harnesses";
import { useRouter } from "../lib/router";
import { ChevronDown, Download, Plus } from "../components/icons";
import { Button, Switch, TextButton } from "../components/ui";
import { Section, Status, Toggle } from "./settings-shared";
import { HarnessLogo } from "../components/HarnessLogo";

/** The shared core state survives navigation and keeps every window in agreement. */
export function AgentConnections({ info, actions }: { info?: SystemInfo; actions?: ReactNode }) {
  const enabled = useEnabledHarnesses();
  const settings = useRpc("app.settings.get", {});
  const selection = useRpcMutation("app.settings.set");
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const select = (enabledHarnesses: HarnessId[]) => {
    setSelectionError(null);
    selection.mutate(
      { enabledHarnesses },
      {
        onSuccess: (saved) => {
          if (saved.enabledHarnesses == null) setSelectionError("Quit and reopen OpenOrc to change enabled agents. The app is still running an older version.");
        },
      },
    );
  };
  const disabled = harnessIds.filter((id) => !enabled.includes(id));
  const updates = useRpc("agents.updates.get", {});
  const check = useRpcMutation("agents.updates.check");
  const install = useRpcMutation("agents.updates.install");
  const configure = useRpcMutation("agents.updates.configure");
  const state = updates.data;
  const busy = Boolean(state?.checking || state?.updating || check.isPending || install.isPending);
  const available = state?.agents.filter((row) => enabled.includes(row.id) && row.status === "available" && row.canUpdate) ?? [];
  const error = [selection.error, settings.error, install.error, check.error, configure.error, updates.error].find(Boolean);
  const checked = state?.agents.map((row) => row.checkedAt ?? 0).reduce((a, b) => Math.max(a, b), 0);
  return (
    <Section title="Coding agents" flush actions={actions}>
      <div className="settings-toolbar">
        <p className="text-sm text-ink-2" role="status">
          {agentUpdateStatus({ updating: Boolean(state?.updating), checking: Boolean(state?.checking || check.isPending), checked })}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={busy || !state}
            onClick={() => {
              install.reset();
              check.mutate({});
            }}
          >
            Check for updates
          </Button>
          {available.length > 0 ? (
            <Button size="sm" disabled={busy} onClick={() => install.mutate({ ids: available.map((row) => row.id) })}>
              Update all{available.length > 1 ? ` (${available.length})` : ""}
            </Button>
          ) : null}
        </div>
      </div>
      {selectionError || error ? (
        <p role="alert" className="text-sm text-bad my-3">
          {selectionError ?? error?.message} {updates.isError ? <TextButton onClick={() => void updates.refetch()}>Try again</TextButton> : null}
        </p>
      ) : null}
      <div className="settings-agent-list" data-plane aria-description="Enabled agents appear in model pickers and can start work. Agents use your CLI login.">
        {enabled.map((id) => (
          <AgentConnection
            key={id}
            id={id}
            info={info?.harnesses.find((row) => row.id === id)}
            update={state?.agents.find((row) => row.id === id)}
            busy={busy}
            onUpdate={() => install.mutate({ ids: [id] })}
            selectionDisabled={!settings.data || selection.isPending}
            onDisable={() => select(enabled.filter((agent) => agent !== id))}
          />
        ))}
        <AddAgents ids={disabled} disabled={!settings.data || selection.isPending} onEnable={(id) => select([...enabled, id])} />
      </div>
      <div className="settings-group settings-agent-preferences">
        <Toggle
          label="Check for agent updates automatically"
          hint="Every six hours while OpenOrc is open. Checks public version information from each agent’s publisher."
          checked={state?.automatic ?? true}
          disabled={!state || configure.isPending}
          onChange={(automatic) => configure.mutate({ automatic })}
        />
      </div>
      <p className="settings-note">Updates start only when agent work has finished. Idle sessions reconnect on your next message; your conversations stay here.</p>
    </Section>
  );
}

function AddAgents({ ids, disabled, onEnable }: { ids: readonly HarnessId[]; disabled: boolean; onEnable: (id: HarnessId) => void }) {
  if (!ids.length) return null;
  return (
    <details className="settings-agent-add">
      <summary aria-label={`Add agents (${ids.length})`}>
        <Plus size={16} />
        <span>
          Add agents <span className="text-ink-3">({ids.length})</span>
        </span>
        <ChevronDown size={14} className="settings-agent-chevron" />
      </summary>
      <div>
        {ids.map((id) => (
          <div className="settings-agent-available" key={id}>
            <span className="inline-flex items-center gap-3.5">
              <HarnessLogo id={id} size={22} />
              {harnessCatalog[id].name}
            </span>
            <Button size="sm" aria-label={`Enable ${harnessCatalog[id].name}`} disabled={disabled} onClick={() => onEnable(id)}>
              Enable
            </Button>
          </div>
        ))}
      </div>
    </details>
  );
}

function AgentConnection({
  id,
  info,
  update,
  busy,
  onUpdate,
  selectionDisabled,
  onDisable,
}: {
  id: HarnessInfo["id"];
  info?: HarnessInfo;
  update?: AgentUpdate;
  busy: boolean;
  onUpdate: () => void;
  selectionDisabled: boolean;
  onDisable: () => void;
}) {
  const harness = harnessCatalog[id];
  const installed = info ? harnessInstalled(info) : false;
  const loggedIn = info ? harnessLoggedIn(info) : false;
  return (
    <div className="settings-agent-row">
      <details className="settings-agent-details">
        <summary aria-label={`${harness.name} details`}>
          <HarnessLogo id={id} size={22} />
          <div className="min-w-0">
            <div className="settings-agent-title">
              <h3>{harness.name}</h3>
              <ChevronDown size={12} className="settings-agent-chevron" />
            </div>
            <div className="settings-agent-meta">
              <Status ok={loggedIn}>{agentConnectionStatus({ info, installed, loggedIn })}</Status>
              {installed ? <span>{update?.installedVersion ?? info?.version ?? "Version unknown"}</span> : null}
              {update?.status === "available" ? <span className="text-ink">Version {update.latestVersion} available</span> : null}
            </div>
          </div>
        </summary>
        <AgentInstallation info={info} update={update} />
      </details>
      <div className="settings-agent-actions">
        {update ? <AgentUpdateAction update={update} name={harness.shortName} busy={busy} onUpdate={onUpdate} /> : null}
        {info && !loggedIn && !installed && !harnessFailsToStart(info) ? (
          <Button size="sm" aria-label={`Install ${harness.name}`} onClick={() => void window.openorc.openExternal(harness.setupUrl)}>
            Install
          </Button>
        ) : null}
        <Switch aria-label={`Enable ${harness.name}`} checked disabled={selectionDisabled} onChange={onDisable} />
      </div>
      {update ? <AgentUpdateDetails update={update} setupUrl={harness.setupUrl} /> : null}
      {info && !loggedIn && !harnessFailsToStart(info) && installed ? (
        <p className="settings-agent-feedback">
          <AgentLoginInstructions id={id} />
        </p>
      ) : null}
    </div>
  );
}

function AgentInstallation({ info, update }: { info?: HarnessInfo; update?: AgentUpdate }) {
  return (
    <div className="settings-agent-installation">
      {update?.method ? <p>Installation: {update.method}</p> : null}
      {info?.path ? <code>{info.path.replace(/^\/Users\/[^/]+/, "~")}</code> : null}
      {update?.status === "current" ? <p>{update.message ?? "Up to date"}</p> : null}
    </div>
  );
}

function AgentLoginInstructions({ id }: { id: HarnessInfo["id"] }) {
  if (id === "claude") return <>Manage your Claude accounts below.</>;
  if (id === "pi")
    return (
      <>
        Run <code>pi</code> in a terminal, then enter <code>/login</code> to connect a provider.
      </>
    );
  return (
    <>
      Connect in a terminal: <code>{harnessCatalog[id].loginCommand}</code>
    </>
  );
}

const actionLabels: Partial<Record<AgentUpdate["status"], string>> = { available: "Update", broken: "Reinstall" };
const progressLabels: Partial<Record<AgentUpdate["status"], string>> = { updating: "Updating…", reinstalling: "Reinstalling…" };

/** The row's one action: run the planned update or reinstall, or show that it is running. */
function AgentUpdateAction({ update, name, busy, onUpdate }: { update: AgentUpdate; name: string; busy: boolean; onUpdate: () => void }) {
  const progress = progressLabels[update.status];
  if (progress)
    return (
      <span role="status" className="text-sm text-ink-2">
        {progress}
      </span>
    );
  const action = actionLabels[update.status];
  if (!action || !update.canUpdate) return null;
  return (
    <Button size="sm" aria-label={`${action} ${name}`} disabled={busy} onClick={onUpdate}>
      {action}
    </Button>
  );
}

function AgentUpdateDetails({ update, setupUrl }: { update: AgentUpdate; setupUrl: string }) {
  const { status } = update;
  const alert = status === "error" || status === "broken";
  const action = actionLabels[status];
  return (
    <>
      {status !== "current" && update.message ? (
        <p className={cn("settings-agent-feedback", alert && "text-bad")} role={alert ? "alert" : undefined}>
          {update.message}
        </p>
      ) : null}
      {action && !update.canUpdate ? (
        <TextButton className="settings-agent-feedback" onClick={() => void window.openorc.openExternal(setupUrl)}>
          {action} instructions
        </TextButton>
      ) : null}
    </>
  );
}

/** A quiet workspace notice; installing stays in Connections where versions and results are visible. */
export function AgentUpdateNotice() {
  const enabled = useEnabledHarnesses();
  const { data } = useRpc("agents.updates.get", {});
  const dismiss = useRpcMutation("agents.updates.configure");
  const route = useRouter((state) => state.route);
  const agents = data?.agents.filter((row) => enabled.includes(row.id)) ?? [];
  const signature = agentUpdateNoticeKey(agents);
  if (!data || data.checking || data.updating || !signature || data.dismissed === signature || (route.view === "settings" && route.section === "connections")) return null;
  const available = agents.filter((row) => row.status === "available");
  return (
    <aside className="agent-update-notice" aria-label="Agent updates" role="status">
      <CoversPreview />
      <Download size={16} className="shrink-0 text-ink-3" />
      <div className="min-w-0 flex-1">
        <p>{available.length === 1 ? `${harnessCatalog[available[0]!.id].name} update available` : `${available.length} agent updates available`}</p>
        <p className="agent-update-notice-detail">
          {available.length === 1 ? `Version ${available[0]!.latestVersion} is ready to review.` : "New versions of your coding agents are ready to review."}
        </p>
        <div className="flex flex-wrap items-center gap-2 mt-3">
          <Button size="sm" onClick={() => useRouter.getState().navigate({ view: "settings", section: "connections" })}>
            Review updates
          </Button>
          <Button size="sm" variant="ghost" disabled={dismiss.isPending} onClick={() => dismiss.mutate({ dismissed: signature })}>
            Later
          </Button>
        </div>
        {dismiss.error ? <p className="text-sm text-bad mt-1">Could not dismiss. Try again.</p> : null}
      </div>
    </aside>
  );
}
