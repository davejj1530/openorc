import { useEffect, useState } from "react";
import { HOSTED_AGENTS, harnessCatalog, type Connector, type HostedAgent, type HostedConnector, type HostedConnectors } from "@openorc/protocol";
import { HarnessLogo } from "../components/HarnessLogo";
import { ChevronDown, Cloud, Plus, X } from "../components/icons";
import { Button, Checkbox, Dialog, IconButton, Input, TextButton } from "../components/ui";
import { queryClient, useRpc, useRpcMutation } from "../lib/client";

type Row = { key: string; value: string; saved: boolean };

/** Why a Mac connector can't be used in the cloud, said on demand on its disabled Set up; null where it can. */
export function cloudReason(connector: Connector): string | null {
  if (connector.kind === "command") return "This connector runs on your Mac.";
  if (connector.agents.some((agent) => agent.places.some((place) => place.status === "needs-sign-in"))) return "This connector needs a cloud sign-in that isn't available yet.";
  return null;
}

/** What the cloud line says of a connector's cloud connections: none, the check's failure, or the agents that have it. */
function cloudStatus(saved: readonly HostedConnector[]): { text: string; ok: boolean; tip: string | null } {
  if (!saved.length) return { text: "Not set up", ok: false, tip: null };
  const failed = saved.find((one) => one.check && one.check.status !== "connected")?.check;
  if (failed) return { text: failed.status === "refused" ? "Refused its headers" : "Couldn't be reached", ok: false, tip: failed.message };
  return { text: saved.map((one) => harnessCatalog[one.agent].name).join(", "), ok: true, tip: null };
}

/**
 * A card's line for the person's own connection of it in the cloud: where it is set up, or why not, and the way to set
 * it up or edit it. Shown only where the server keeps connectors, for a connector of the person's own with a kind.
 */
export function CloudLine({ connector, active }: { connector: Connector; active: boolean }) {
  const cloud = useRpc("hostedConnectors.read", {}, { enabled: active });
  const [open, setOpen] = useState(false);
  if (cloud.data?.state !== "ready" || connector.kind === null) return null;
  const saved = cloud.data.connectors.filter((one) => one.name === connector.name);
  const reason = saved.length ? null : cloudReason(connector);
  const status = cloudStatus(saved);
  const action = saved.length ? "Edit" : "Set up";
  return (
    <div className="connector-agent">
      <Cloud size={14} />
      <span className="connector-agent-name">OpenOrc Cloud</span>
      <span className="connector-agent-status" data-ok={status.ok || undefined} data-tip={status.tip ?? status.text}>
        {status.text}
      </span>
      {reason ? (
        <span data-tip={reason} tabIndex={0}>
          <Button size="sm" variant="ghost" className="-mr-3" disabled aria-label={`${action} ${connector.title} in the cloud`}>
            {action}
          </Button>
        </span>
      ) : (
        <Button size="sm" variant="ghost" className="-mr-3" aria-label={`${action} ${connector.title} in the cloud`} onClick={() => setOpen(true)}>
          {action}
        </Button>
      )}
      {open ? <CloudConnectorSheet connector={connector} saved={saved} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

const onTheMac = (connector: Connector): HostedAgent[] => HOSTED_AGENTS.filter((agent) => connector.agents.some((one) => one.agent === agent && one.places.some((place) => place.status !== "off")));

/**
 * One connector in the cloud: its address, its headers and the agents whose cloud turns get it. Headers already saved
 * read "Saved" and are kept unless retyped; "Use this Mac's headers" reads this Mac's settings of it, only when pressed.
 */
export function CloudConnectorSheet({ connector, saved, onClose }: { connector: Connector; saved: readonly HostedConnector[]; onClose: () => void }) {
  const save = useRpcMutation("hostedConnectors.save");
  const remove = useRpcMutation("hostedConnectors.remove");
  const spec = useRpcMutation("connectors.spec");
  const first = saved[0];
  const [url, setUrl] = useState(first?.url ?? "");
  const [rows, setRows] = useState<Row[]>(first ? first.headers.map((header) => ({ key: header.name, value: "", saved: true })) : []);
  const [agents, setAgents] = useState<HostedAgent[]>(saved.length ? saved.map((one) => one.agent) : onTheMac(connector));
  const [changed, setChanged] = useState(!first);
  const macAgent = connector.agents.find((agent) => agent.editable)?.agent ?? connector.agents[0]?.agent;
  // A new one starts at this Mac's address; its headers wait for the button.
  useEffect(() => {
    if (first || !macAgent) return;
    void spec.mutateAsync({ agent: macAgent, name: connector.name }).then((read) => {
      if (read?.kind === "url") setUrl((now) => now || read.url);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, as the sheet opens
  }, []);
  const change =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setChanged(true);
    };
  const fillFromMac = async () => {
    if (!macAgent) return;
    const read = await spec.mutateAsync({ agent: macAgent, name: connector.name });
    if (read?.kind !== "url") return;
    setUrl((now) => now || read.url);
    setRows(Object.entries(read.headers).map(([key, value]) => ({ key, value, saved: false })));
    setChanged(true);
  };
  // What the server says the person has now is what every card reads.
  const done = (answer: HostedConnectors) => {
    queryClient.setQueryData(["hostedConnectors.read", {}], answer);
    onClose();
  };
  const submit = () => {
    const headers = rows.filter((row) => row.key.trim()).map((row) => (row.saved && !row.value ? { name: row.key.trim(), keep: true as const } : { name: row.key.trim(), value: row.value }));
    save.mutate({ name: connector.name, url: url.trim(), headers, agents }, { onSuccess: (answer) => done(answer) });
  };
  return (
    <Dialog className="connector-dialog" open onOpenChange={(isOpen) => !isOpen && onClose()} title={`${connector.title} in the cloud`} width={520}>
      <form
        className="connector-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <fieldset className="connector-form-fields" disabled={save.isPending || remove.isPending}>
          <div className="connector-form-connection">
            <label className="connector-form-field">
              <span>Server address</span>
              <Input variant="sheet" value={url} onChange={(event) => change(setUrl)(event.target.value)} placeholder="https://example.com/mcp" spellCheck={false} />
            </label>
            <HeaderRows rows={rows} onChange={change(setRows)} onFromMac={macAgent && !spec.isPending ? () => void fillFromMac() : null} />
          </div>
          <CloudAgentChoice agents={agents} onChange={change(setAgents)} />
        </fieldset>
        <SheetFooter
          problem={save.error?.message ?? remove.error?.message ?? spec.error?.message}
          canSave={changed && Boolean(url.trim()) && agents.length > 0 && !save.isPending}
          saving={save.isPending}
          onRemove={first ? () => remove.mutate({ name: connector.name }, { onSuccess: (answer) => done(answer) }) : null}
          onClose={onClose}
        />
      </form>
    </Dialog>
  );
}

/** A connector's headers: a saved one reads "Saved" and is kept unless retyped; renamed, it is a new one. */
function HeaderRows({ rows, onChange, onFromMac }: { rows: Row[]; onChange: (rows: Row[]) => void; onFromMac: (() => void) | null }) {
  const setRow = (index: number, patch: Partial<Row>) => onChange(rows.map((row, at) => (at === index ? { ...row, ...patch, saved: patch.key !== undefined ? false : row.saved } : row)));
  return (
    <details className="connector-form-options motion-disclosure" open>
      <summary>
        Headers
        <ChevronDown size={14} />
      </summary>
      <div className="connector-form-pairs">
        {rows.map((row, index) => (
          <div key={index} className="connector-form-pair">
            <Input variant="sheet" aria-label={`Header ${index + 1}`} placeholder="Header" value={row.key} onChange={(event) => setRow(index, { key: event.target.value })} />
            <Input
              variant="sheet"
              aria-label={`Value ${index + 1}`}
              placeholder={row.saved ? "Saved" : "Value"}
              type="password"
              autoComplete="off"
              value={row.value}
              onChange={(event) => setRow(index, { value: event.target.value })}
            />
            <IconButton aria-label={`Remove ${row.key || "header"}`} size="sm" onClick={() => onChange(rows.filter((_, at) => at !== index))}>
              <X size={14} />
            </IconButton>
          </div>
        ))}
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => onChange([...rows, { key: "", value: "", saved: false }])}>
            <Plus size={13} />
            Add header
          </Button>
          <Button size="sm" variant="ghost" disabled={!onFromMac} onClick={() => onFromMac?.()}>
            Use this Mac's headers
          </Button>
        </div>
      </div>
    </details>
  );
}

/** The agents whose cloud turns get the connector. */
function CloudAgentChoice({ agents, onChange }: { agents: HostedAgent[]; onChange: (agents: HostedAgent[]) => void }) {
  return (
    <fieldset className="connector-form-agents">
      <legend>Use with</legend>
      <div className="connector-form-agent-grid">
        {HOSTED_AGENTS.map((agent) => (
          <label key={agent} className="connector-form-agent">
            <HarnessLogo id={agent} size={16} />
            <span>{harnessCatalog[agent].name}</span>
            <Checkbox checked={agents.includes(agent)} onChange={(event) => onChange(event.target.checked ? [...agents, agent] : agents.filter((one) => one !== agent))} />
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** The sheet's foot: what went wrong, Remove from the cloud for a saved one, Cancel and Save. */
function SheetFooter({ problem, canSave, saving, onRemove, onClose }: { problem: string | undefined; canSave: boolean; saving: boolean; onRemove: (() => void) | null; onClose: () => void }) {
  return (
    <div className="connector-form-footer">
      {problem ? (
        <p role="alert" className="text-sm text-bad">
          {problem}
        </p>
      ) : null}
      <div className="connector-form-actions">
        {onRemove ? (
          <TextButton type="button" tone="danger" className="mr-auto" onClick={onRemove}>
            Remove from the cloud
          </TextButton>
        ) : null}
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!canSave}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
