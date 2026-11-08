import { useEffect, useState } from "react";
import { harnessCatalog, harnessIds, type ConnectorList, type ConnectorSpec, type HarnessId } from "@openorc/protocol";
import { Plus, X } from "../components/icons";
import { Button, Dialog, IconButton, Input } from "../components/ui";
import { useRpcMutation } from "../lib/client";
import { joinCommandLine, splitCommandLine } from "../lib/connector-presentation";

/** What the form starts from: nothing for a new connector, or what was saved. */
export interface ConnectorDraft {
  name: string;
  spec: ConnectorSpec | null;
  agents: HarnessId[];
}

type Pair = { key: string; value: string };
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const pairs = (record: Record<string, string>): Pair[] => Object.entries(record).map(([key, value]) => ({ key, value }));
const record = (rows: Pair[]) => Object.fromEntries(rows.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value]));

function Pairs({ label, rows, onChange, keyLabel }: { label: string; rows: Pair[]; onChange: (rows: Pair[]) => void; keyLabel: string }) {
  const change = (index: number, patch: Partial<Pair>) => onChange(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  return (
    <fieldset className="connector-form-pairs">
      <legend>{label}</legend>
      {rows.map((row, index) => (
        <div key={index} className="connector-form-pair">
          <Input aria-label={`${keyLabel} ${index + 1}`} placeholder={keyLabel} value={row.key} onChange={(event) => change(index, { key: event.target.value })} />
          <Input aria-label={`Value ${index + 1}`} placeholder="Value" type="password" autoComplete="off" value={row.value} onChange={(event) => change(index, { value: event.target.value })} />
          <IconButton aria-label={`Remove ${row.key || keyLabel.toLowerCase()}`} size="sm" onClick={() => onChange(rows.filter((_, at) => at !== index))}>
            <X size={14} />
          </IconButton>
        </div>
      ))}
      <Button size="sm" onClick={() => onChange([...rows, { key: "", value: "" }])}>
        <Plus size={13} />
        Add
      </Button>
    </fieldset>
  );
}

function AgentChoice({ agents, missing, onChange }: { agents: HarnessId[]; missing: Map<HarnessId, string>; onChange: (agents: HarnessId[]) => void }) {
  return (
    <fieldset className="connector-form-agents">
      <legend>Agents</legend>
      {harnessIds.map((agent) => (
        <label key={agent} title={missing.get(agent)}>
          <input
            type="checkbox"
            checked={agents.includes(agent)}
            disabled={missing.has(agent)}
            onChange={(event) => onChange(event.target.checked ? [...agents, agent] : agents.filter((entry) => entry !== agent))}
          />
          {harnessCatalog[agent].name}
        </label>
      ))}
    </fieldset>
  );
}

/** Adds or edits one connector for the agents chosen. Each agent saves it in its own configuration. */
export function ConnectorForm({ draft, unavailable, onClose }: { draft: ConnectorDraft | null; unavailable: ConnectorList["unavailable"]; onClose: () => void }) {
  const save = useRpcMutation("connectors.save");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ConnectorSpec["kind"]>("url");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [extras, setExtras] = useState<Pair[]>([]);
  const [agents, setAgents] = useState<HarnessId[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const missing = new Map(unavailable.map((entry) => [entry.agent, entry.reason]));

  useEffect(() => {
    if (!draft) return;
    const spec = draft.spec;
    setName(draft.name);
    setKind(spec?.kind ?? "url");
    setUrl(spec?.kind === "url" ? spec.url : "");
    setCommand(spec?.kind === "command" ? joinCommandLine([spec.command, ...spec.args]) : "");
    setExtras(spec ? pairs(spec.kind === "url" ? spec.headers : spec.env) : []);
    setAgents(draft.agents.length ? draft.agents : harnessIds.filter((agent) => !missing.has(agent)));
    setProblem(null);
    save.reset();
    // A draft opens the form once; later list reads must not reset what the user is typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const submit = async () => {
    const words = splitCommandLine(command);
    if (!NAME.test(name)) return setProblem("Use letters, numbers, - or _ in the name.");
    if (kind === "url" && !/^https?:\/\/\S+$/i.test(url.trim())) return setProblem("Enter the server’s address, starting with https://.");
    if (kind === "command" && !words.length) return setProblem("Enter the command that starts the server.");
    if (!agents.length) return setProblem("Choose at least one agent.");
    setProblem(null);
    const spec: ConnectorSpec = kind === "url" ? { kind, url: url.trim(), headers: record(extras) } : { kind, command: words[0]!, args: words.slice(1), env: record(extras) };
    const result = await save.mutateAsync({ name, ...(draft?.name ? { previousName: draft.name } : {}), spec, agents });
    if (result.failed.length) setProblem(result.failed.map((entry) => `${harnessCatalog[entry.agent].name}: ${entry.reason}`).join(" "));
    else onClose();
  };

  return (
    <Dialog open={draft !== null} onOpenChange={(open) => !open && onClose()} title={draft?.name ? `Edit ${draft.name}` : "Add connector"} width={520}>
      <form
        className="connector-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="connector-form-field">
          <span>Name</span>
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="paper" autoFocus spellCheck={false} />
        </label>
        <div className="connector-form-kinds" role="group" aria-label="Runs as">
          <button type="button" aria-pressed={kind === "url"} onClick={() => setKind("url")}>
            Address
          </button>
          <button type="button" aria-pressed={kind === "command"} onClick={() => setKind("command")}>
            Command
          </button>
        </div>
        {kind === "url" ? (
          <label className="connector-form-field">
            <span>Address</span>
            <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/mcp" spellCheck={false} />
          </label>
        ) : (
          <label className="connector-form-field">
            <span>Command</span>
            <Input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx -y @example/mcp" spellCheck={false} className="font-mono" />
          </label>
        )}
        <Pairs label={kind === "url" ? "Headers" : "Environment variables"} keyLabel={kind === "url" ? "Header" : "Variable"} rows={extras} onChange={setExtras} />
        <AgentChoice agents={agents} missing={missing} onChange={setAgents} />
        {problem || save.error ? (
          <p role="alert" className="text-sm text-bad">
            {problem ?? save.error?.message}
          </p>
        ) : null}
        <div className="connector-form-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
