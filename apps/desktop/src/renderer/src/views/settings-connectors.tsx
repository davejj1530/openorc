import { Menu } from "@base-ui/react/menu";
import { useEffect, useState } from "react";
import { harnessCatalog, type AgentConnector, type Connector, type ConnectorList } from "@openorc/protocol";
import { ConnectorLogo } from "../components/ConnectorLogo";
import { ChevronDown, MoreHorizontal, Plus, RefreshCw } from "../components/icons";
import { menuItem, menuItemDanger, menuPopup } from "../components/menu";
import { Button, IconButton, Switch } from "../components/ui";
import { CoversPreview } from "../lib/browser-preview";
import { useRpc, useRpcMutation } from "../lib/client";
import { agentName, agentStatusText, connectorStatus, isDormant, isYours, statusLabel } from "../lib/connector-presentation";
import { floatingGround } from "../lib/use-anchor-ground";
import { ConnectorForm, type ConnectorDraft } from "./settings-connector-form";
import { LoadError, Status } from "./settings-shared";
import "./settings-connectors.css";

/** What a line says while its switch waits for a read to agree. */
function switchingText(wanted: boolean | null): string | null {
  if (wanted === null) return null;
  return wanted ? "Turning on…" : "Off";
}

function AgentLine({ connector, agent }: { connector: Connector; agent: AgentConnector }) {
  const setOn = useRpcMutation("connectors.setOn");
  const on = !agent.places.every((place) => place.status === "off");
  // The switch holds where it was put until a read agrees, which can take as long as the agent takes to start its servers.
  const [wanted, setWanted] = useState<boolean | null>(null);
  useEffect(() => {
    if (wanted === on) setWanted(null);
  }, [on, wanted]);
  const error = agent.places.find((place) => place.error)?.error;
  return (
    <div className="connector-agent">
      <span className="connector-agent-name">{agentName(agent)}</span>
      <span className="connector-agent-status" title={error}>
        {switchingText(wanted) ?? agentStatusText(agent)}
      </span>
      {agent.switchable ? (
        <Switch
          size="sm"
          aria-label={`${connector.title} in ${agentName(agent)}`}
          checked={wanted ?? on}
          disabled={wanted !== null}
          onChange={(event) => {
            setWanted(event.target.checked);
            setOn.mutate({ agent: agent.agent, name: connector.name, on: event.target.checked }, { onError: () => setWanted(null) });
          }}
        />
      ) : null}
    </div>
  );
}

const failureText = (failed: ConnectorList["unavailable"]) => failed.map((entry) => `${harnessCatalog[entry.agent].name}: ${entry.reason}`).join(" ");

function RowMenu({ connector, onEdit, onProblem }: { connector: Connector; onEdit: () => void; onProblem: (problem: string | null) => void }) {
  const report = { onSuccess: ({ failed }: { failed: ConnectorList["unavailable"] }) => onProblem(failed.length ? failureText(failed) : null), onError: (error: Error) => onProblem(error.message) };
  const remove = useRpcMutation("connectors.remove");
  const signOut = useRpcMutation("connectors.signOut");
  const signedIn = connector.kind === "url" && connector.agents.some((agent) => agent.places.some((place) => place.status === "connected"));
  if (!isYours(connector) && !signedIn) return null;
  return (
    <Menu.Root>
      <Menu.Trigger render={<IconButton aria-label={`More for ${connector.title}`} size="sm" />}>
        <MoreHorizontal size={16} />
      </Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner sideOffset={6} align="end" className="z-40" collisionPadding={8}>
          <Menu.Popup ref={floatingGround} className={menuPopup}>
            {isYours(connector) ? (
              <Menu.Item className={menuItem} onClick={onEdit}>
                Edit
              </Menu.Item>
            ) : null}
            {signedIn ? (
              <Menu.Item className={menuItem} onClick={() => signOut.mutate({ name: connector.name }, report)}>
                Sign out
              </Menu.Item>
            ) : null}
            {isYours(connector) ? (
              <Menu.Item className={menuItemDanger} onClick={() => remove.mutate({ name: connector.name }, report)}>
                Remove
              </Menu.Item>
            ) : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function ConnectorRow({ connector, busy, onEdit }: { connector: Connector; busy: boolean; onEdit: () => void }) {
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const signIn = useRpcMutation("connectors.signIn");
  const status = connectorStatus(connector);
  const detail = `connector-detail-${connector.name}`;
  return (
    <li className="connector-row" data-open={open || undefined}>
      <div className="connector-head">
        <button type="button" className="connector-toggle" aria-expanded={open} aria-controls={detail} onClick={() => setOpen(!open)}>
          <ConnectorLogo title={connector.title} logo={connector.logo} />
          <span className="connector-name">
            <span>{connector.title}</span>
            <span className="connector-agents">{connector.agents.map(agentName).join(", ")}</span>
          </span>
          <Status ok={status === "connected"}>{statusLabel[status]}</Status>
          <ChevronDown size={14} className="connector-chevron" aria-hidden="true" />
        </button>
        {status === "needs-sign-in" ? (
          <Button size="sm" disabled={busy || signIn.isPending} onClick={() => signIn.mutate({ name: connector.name })}>
            Sign in
          </Button>
        ) : null}
        <RowMenu connector={connector} onEdit={onEdit} onProblem={setProblem} />
      </div>
      {problem ? (
        <p role="alert" className="connector-problem text-bad">
          {problem}
        </p>
      ) : null}
      {open ? (
        <div id={detail} className="connector-detail">
          {connector.agents.map((agent) => (
            <AgentLine key={agent.agent} connector={connector} agent={agent} />
          ))}
        </div>
      ) : null}
    </li>
  );
}

function ConnectorGroup({ title, connectors, busy, onEdit }: { title: string; connectors: Connector[]; busy: boolean; onEdit: (connector: Connector) => void }) {
  if (!connectors.length) return null;
  return (
    <section className="settings-section">
      <header className="settings-section-intro">
        <h2>{title}</h2>
      </header>
      <ul className="settings-group connector-list">
        {connectors.map((connector) => (
          <ConnectorRow key={connector.name} connector={connector} busy={busy} onEdit={() => onEdit(connector)} />
        ))}
      </ul>
    </section>
  );
}

function SignInProgress({ list }: { list: ConnectorList }) {
  const cancel = useRpcMutation("connectors.cancelSignIn");
  if (list.signIn) {
    const { name, agent, accountName, remaining } = list.signIn;
    const where = accountName ? `${harnessCatalog[agent].name} (${accountName})` : harnessCatalog[agent].name;
    return (
      <div className="connector-progress" role="status">
        <span>
          Signing in to {name} for {where} in your browser{remaining ? `. ${remaining} more after this.` : "."}
        </span>
        <Button size="sm" onClick={() => cancel.mutate({})}>
          Cancel
        </Button>
      </div>
    );
  }
  return list.signInError ? (
    <p className="connector-progress text-bad" role="alert">
      {list.signInError}
    </p>
  ) : null;
}

export function ConnectorSettings({ active }: { active: boolean }) {
  const list = useRpc("connectors.list", {}, { enabled: active, refetchInterval: (query) => (active && (query.state.data?.signIn || query.state.data?.checking) ? 1500 : false) });
  const refresh = useRpcMutation("connectors.list");
  const spec = useRpcMutation("connectors.spec");
  const [draft, setDraft] = useState<ConnectorDraft | null>(null);
  const connectors = list.data?.connectors ?? [];
  const busy = Boolean(list.data?.signIn);
  const dormant = connectors.filter(isDormant);
  const edit = async (connector: Connector) => {
    const agents = connector.agents.filter((agent) => agent.editable).map((agent) => agent.agent);
    const saved = agents[0] ? await spec.mutateAsync({ agent: agents[0], name: connector.name }) : null;
    setDraft({ name: connector.name, spec: saved, agents });
  };
  return (
    <>
      <div className="settings-toolbar">
        <p>{list.data?.checking || refresh.isPending ? "Checking connectors…" : null}</p>
        <span className="flex items-center gap-2">
          <IconButton aria-label="Check again" size="sm" disabled={refresh.isPending} onClick={() => refresh.mutate({ refresh: true })}>
            <RefreshCw size={14} />
          </IconButton>
          <Button size="lg" onClick={() => setDraft({ name: "", spec: null, agents: [] })}>
            <Plus size={14} />
            Add connector
          </Button>
        </span>
      </div>
      {list.isError ? <LoadError retry={() => void list.refetch()} /> : null}
      {list.data ? <SignInProgress list={list.data} /> : null}
      {list.isPending ? <p className="settings-note">Checking connectors…</p> : null}
      {list.data && !connectors.length ? <p className="settings-note">No connectors yet.</p> : null}
      <ConnectorGroup title="Yours" connectors={connectors.filter((connector) => isYours(connector) && !isDormant(connector))} busy={busy} onEdit={(connector) => void edit(connector)} />
      <ConnectorGroup
        title="From projects, plugins and accounts"
        connectors={connectors.filter((connector) => !isYours(connector) && !isDormant(connector))}
        busy={busy}
        onEdit={(connector) => void edit(connector)}
      />
      {dormant.length ? (
        <details className="settings-disclosure connector-dormant">
          <summary>Not connected on your Claude account ({dormant.length})</summary>
          <ul className="connector-list">
            {dormant.map((connector) => (
              <ConnectorRow key={connector.name} connector={connector} busy={busy} onEdit={() => undefined} />
            ))}
          </ul>
        </details>
      ) : null}
      {list.data?.unavailable.map((entry) => (
        <p key={entry.agent} className="settings-note">
          {harnessCatalog[entry.agent].name}: {entry.reason}
        </p>
      ))}
      {spec.error ? (
        <p role="alert" className="text-sm text-bad mt-2">
          {spec.error.message}
        </p>
      ) : null}
      <ConnectorForm draft={draft} unavailable={list.data?.unavailable ?? []} onClose={() => setDraft(null)} />
    </>
  );
}
