import { agentUpdateStatus, agentConnectionStatus } from "./settings-presentation";
import { agentUpdateNoticeKey, harnessCatalog, harnessFailsToStart, harnessIds, harnessInstalled, harnessLoggedIn, type AgentUpdate, type HarnessInfo, type SystemInfo } from "@openorc/protocol";
import { cn } from "../lib/cn";
import { useRpc, useRpcMutation } from "../lib/query";
import { useRouter } from "../lib/router";
import { Download, X } from "../components/icons";
import { Badge, Button, IconButton, TextButton } from "../components/ui";
import { Section, Toggle } from "./settings-shared";

/** The shared core state survives navigation and keeps every window in agreement. */
export function AgentConnections({ info }: { info?: SystemInfo }) {
  const updates = useRpc("agents.updates.get", {});
  const check = useRpcMutation("agents.updates.check");
  const install = useRpcMutation("agents.updates.install");
  const configure = useRpcMutation("agents.updates.configure");
  const state = updates.data;
  const busy = Boolean(state?.checking || state?.updating || check.isPending || install.isPending);
  const available = state?.agents.filter((row) => row.status === "available" && row.canUpdate) ?? [];
  const error = install.error ?? check.error ?? configure.error ?? updates.error;
  const checked = state?.agents.map((row) => row.checkedAt ?? 0).reduce((a, b) => Math.max(a, b), 0);
  return (
    <Section title="Coding agents" description="Agents use your CLI login. OpenOrc does not read their credential files.">
      <div className="agent-update-toolbar">
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
      {error ? (
        <p role="alert" className="text-sm text-bad my-3">
          {error.message} {updates.isError ? <TextButton onClick={() => void updates.refetch()}>Try again</TextButton> : null}
        </p>
      ) : null}
      {harnessIds.map((id) => (
        <AgentConnection
          key={id}
          id={id}
          info={info?.harnesses.find((row) => row.id === id)}
          update={state?.agents.find((row) => row.id === id)}
          busy={busy}
          onUpdate={() => install.mutate({ ids: [id] })}
        />
      ))}
      <p className="text-sm text-ink-2 mt-4">Updates start only when agent work has finished. Idle sessions reconnect on your next message; your conversations stay here.</p>
      <Toggle
        label="Check for agent updates automatically"
        hint="Every six hours while OpenOrc is open. Checks contact npm or Homebrew for public version information."
        checked={state?.automatic ?? true}
        disabled={!state || configure.isPending}
        onChange={(automatic) => configure.mutate({ automatic })}
      />
    </Section>
  );
}

function AgentConnection({ id, info, update, busy, onUpdate }: { id: HarnessInfo["id"]; info?: HarnessInfo; update?: AgentUpdate; busy: boolean; onUpdate: () => void }) {
  const harness = harnessCatalog[id];
  const installed = info ? harnessInstalled(info) : false;
  const loggedIn = info ? harnessLoggedIn(info) : false;
  return (
    <div className="settings-agent">
      <div className="agent-update-row">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{harness.name}</h3>
            <Badge tone={loggedIn ? "ok" : "muted"}>{agentConnectionStatus({ info, installed, loggedIn })}</Badge>
          </div>
          {installed ? (
            <p className="text-sm text-ink-2 mt-1">
              {update?.installedVersion ?? info?.version ?? "Version unknown"}
              {update?.method ? ` · ${update.method}` : ""}
            </p>
          ) : null}
          {info?.path ? <code className="settings-path text-sm mt-1">{info.path.replace(/^\/Users\/[^/]+/, "~")}</code> : null}
        </div>
        {update ? <AgentUpdateAction update={update} name={harness.shortName} busy={busy} onUpdate={onUpdate} /> : null}
      </div>
      {update ? <AgentUpdateDetails update={update} setupUrl={harness.setupUrl} /> : null}
      {info && !loggedIn && !harnessFailsToStart(info) ? (
        <p className="text-ink-2 mt-2">
          {installed ? (
            <>
              Connect in a terminal: <code>{harness.loginCommand}</code>
            </>
          ) : (
            <Button onClick={() => void window.openorc.openExternal(harness.setupUrl)}>Install {harness.name}</Button>
          )}
        </p>
      ) : null}
    </div>
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
    <Button size="sm" disabled={busy} onClick={onUpdate}>
      {action} {name}
    </Button>
  );
}

function AgentUpdateDetails({ update, setupUrl }: { update: AgentUpdate; setupUrl: string }) {
  const { status } = update;
  const alert = status === "error" || status === "broken";
  const action = actionLabels[status];
  return (
    <>
      {status === "available" && <p className="text-sm mt-2">Version {update.latestVersion} available</p>}
      {status === "current" && <p className="text-sm text-ink-2 mt-2">Up to date</p>}
      {update.message ? (
        <p className={cn("text-sm mt-2", alert && "text-bad", !alert && "text-ink-2")} role={alert ? "alert" : undefined}>
          {update.message}
        </p>
      ) : null}
      {action && !update.canUpdate ? (
        <TextButton className="text-sm mt-2" onClick={() => void window.openorc.openExternal(setupUrl)}>
          {action} instructions
        </TextButton>
      ) : null}
    </>
  );
}

/** A quiet workspace notice; installing stays in Connections where versions and results are visible. */
export function AgentUpdateNotice() {
  const { data } = useRpc("agents.updates.get", {});
  const dismiss = useRpcMutation("agents.updates.configure");
  const route = useRouter((state) => state.route);
  const signature = agentUpdateNoticeKey(data?.agents ?? []);
  if (!data || data.checking || data.updating || !signature || data.dismissed === signature || (route.view === "settings" && route.section === "connections")) return null;
  const available = data.agents.filter((row) => row.status === "available");
  return (
    <aside className="agent-update-notice" aria-label="Agent updates" role="status">
      <Download size={18} className="shrink-0 text-ink-2 mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{available.length === 1 ? `${harnessCatalog[available[0]!.id].name} update available` : `${available.length} agent updates available`}</p>
        <p className="text-sm text-ink-2 mt-1">{available.length === 1 ? `Version ${available[0]!.latestVersion} is ready to review.` : "New versions of your coding agents are ready to review."}</p>
        <TextButton className="mt-3 text-sm" onClick={() => useRouter.getState().navigate({ view: "settings", section: "connections" })}>
          Review updates
        </TextButton>
        {dismiss.error ? <p className="text-sm text-bad mt-1">Could not dismiss. Try again.</p> : null}
      </div>
      <IconButton aria-label="Dismiss agent updates" disabled={dismiss.isPending} onClick={() => dismiss.mutate({ dismissed: signature })}>
        <X size={16} />
      </IconButton>
    </aside>
  );
}
