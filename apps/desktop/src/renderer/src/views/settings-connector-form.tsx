import { useEffect, useState } from "react";
import { harnessCatalog, type ConnectorList, type ConnectorSpec, type HarnessId } from "@openorc/protocol";
import { useEnabledHarnesses } from "../lib/enabled-harnesses";
import { ChevronDown, Plus, X } from "../components/icons";
import { HarnessLogo } from "../components/HarnessLogo";
import { Button, Checkbox, Dialog, IconButton, Input, Segmented } from "../components/ui";
import { useRpcMutation } from "../lib/client";
import { joinCommandLine, splitCommandLine } from "../lib/connector-presentation";

/** What the form starts from: nothing for a new connector, or what was saved. */
export interface ConnectorDraft {
  name: string;
  spec: ConnectorSpec | null;
  agents: HarnessId[];
}

type Pair = { key: string; value: string };
const connectionKinds = [
  { value: "url", label: "Server URL" },
  { value: "command", label: "Command" },
] as const;
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const pairs = (record: Record<string, string>): Pair[] => Object.entries(record).map(([key, value]) => ({ key, value }));
const record = (rows: Pair[]) => Object.fromEntries(rows.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value]));

function Pairs({ rows, onChange, keyLabel }: { rows: Pair[]; onChange: (rows: Pair[]) => void; keyLabel: string }) {
  const change = (index: number, patch: Partial<Pair>) => onChange(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  return (
    <div className="connector-form-pairs">
      {rows.map((row, index) => (
        <div key={index} className="connector-form-pair">
          <Input variant="sheet" aria-label={`${keyLabel} ${index + 1}`} placeholder={keyLabel} value={row.key} onChange={(event) => change(index, { key: event.target.value })} />
          <Input
            variant="sheet"
            aria-label={`Value ${index + 1}`}
            placeholder="Value"
            type="password"
            autoComplete="off"
            value={row.value}
            onChange={(event) => change(index, { value: event.target.value })}
          />
          <IconButton aria-label={`Remove ${row.key || keyLabel.toLowerCase()}`} size="sm" onClick={() => onChange(rows.filter((_, at) => at !== index))}>
            <X size={14} />
          </IconButton>
        </div>
      ))}
      <Button size="sm" variant="ghost" onClick={() => onChange([...rows, { key: "", value: "" }])}>
        <Plus size={13} />
        Add {keyLabel.toLowerCase()}
      </Button>
    </div>
  );
}

function AgentChoice({ agents, missing, onChange }: { agents: HarnessId[]; missing: Map<HarnessId, string>; onChange: (agents: HarnessId[]) => void }) {
  const enabled = useEnabledHarnesses();
  return (
    <fieldset className="connector-form-agents">
      <legend>Use with</legend>
      <div className="connector-form-agent-grid">
        {enabled.map((agent) => (
          <label key={agent} className="connector-form-agent" data-tip={missing.get(agent)} data-disabled={missing.has(agent) || undefined}>
            <HarnessLogo id={agent} size={16} />
            <span>{harnessCatalog[agent].name}</span>
            <Checkbox
              checked={agents.includes(agent)}
              disabled={missing.has(agent)}
              onChange={(event) => onChange(event.target.checked ? [...agents, agent] : agents.filter((entry) => entry !== agent))}
            />
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Adds or edits one connector for the agents chosen. Each agent saves it in its own configuration. */
export function ConnectorForm({ draft, unavailable, onClose }: { draft: ConnectorDraft | null; unavailable: ConnectorList["unavailable"]; onClose: () => void }) {
  const enabled = useEnabledHarnesses();
  const save = useRpcMutation("connectors.save");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ConnectorSpec["kind"]>("url");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [extras, setExtras] = useState<Pair[]>([]);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [agents, setAgents] = useState<HarnessId[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const missing = new Map(unavailable.map((entry) => [entry.agent, entry.reason]));
  const saveLabel = draft?.name ? "Save changes" : "Add connector";

  useEffect(() => {
    if (!draft) return;
    const spec = draft.spec;
    setName(draft.name);
    setKind(spec?.kind ?? "url");
    setUrl(spec?.kind === "url" ? spec.url : "");
    setCommand(spec?.kind === "command" ? joinCommandLine([spec.command, ...spec.args]) : "");
    setExtras(spec ? pairs(spec.kind === "url" ? spec.headers : spec.env) : []);
    setOptionsOpen(Boolean(spec && Object.keys(spec.kind === "url" ? spec.headers : spec.env).length));
    setAgents((draft.agents.length ? draft.agents : enabled).filter((agent) => enabled.includes(agent) && !missing.has(agent)));
    setProblem(null);
    save.reset();
    // A draft opens the form once; later list reads must not reset what the user is typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const submit = () => {
    const words = splitCommandLine(command);
    if (!NAME.test(name)) return setProblem("Use letters, numbers, - or _ in the name.");
    if (kind === "url" && !/^https?:\/\/\S+$/i.test(url.trim())) return setProblem("Enter the server’s address, starting with https://.");
    if (kind === "command" && !words.length) return setProblem("Enter the command that starts the server.");
    if (!agents.length) return setProblem("Choose at least one agent.");
    setProblem(null);
    const spec: ConnectorSpec = kind === "url" ? { kind, url: url.trim(), headers: record(extras) } : { kind, command: words[0]!, args: words.slice(1), env: record(extras) };
    save.mutate(
      { name, ...(draft?.name ? { previousName: draft.name } : {}), spec, agents },
      {
        onSuccess: (result) => {
          if (result.failed.length) setProblem(result.failed.map((entry) => `${harnessCatalog[entry.agent].name}: ${entry.reason}`).join(" "));
          else onClose();
        },
      },
    );
  };

  return (
    <Dialog className="connector-dialog" open={draft !== null} onOpenChange={(open) => !open && onClose()} title={draft?.name ? `Edit ${draft.name}` : "Add connector"} width={520}>
      <form
        className="connector-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <fieldset className="connector-form-fields" disabled={save.isPending}>
          <label className="connector-form-field">
            <span>Name</span>
            <Input variant="sheet" value={name} onChange={(event) => setName(event.target.value)} placeholder="my-connector" autoFocus spellCheck={false} />
          </label>
          <div className="connector-form-connection">
            <Segmented label="Connection type" value={kind} options={connectionKinds} onChange={setKind} />
            {kind === "url" ? (
              <label className="connector-form-field">
                <span>Server address</span>
                <Input variant="sheet" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/mcp" spellCheck={false} />
              </label>
            ) : (
              <label className="connector-form-field">
                <span>Command</span>
                <Input variant="sheet" value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx -y @example/mcp" spellCheck={false} className="font-mono" />
              </label>
            )}
            <details className="connector-form-options motion-disclosure" open={optionsOpen} onToggle={(event) => setOptionsOpen(event.currentTarget.open)}>
              <summary>
                {kind === "url" ? "Headers" : "Environment variables"}
                <ChevronDown size={14} />
              </summary>
              <Pairs keyLabel={kind === "url" ? "Header" : "Variable"} rows={extras} onChange={setExtras} />
            </details>
          </div>
          <AgentChoice agents={agents} missing={missing} onChange={setAgents} />
        </fieldset>
        <ConnectorFormFooter problem={problem ?? save.error?.message} saving={save.isPending} label={saveLabel} onClose={onClose} />
      </form>
    </Dialog>
  );
}

function ConnectorFormFooter({ problem, saving, label, onClose }: { problem: string | undefined; saving: boolean; label: string; onClose: () => void }) {
  return (
    <div className="connector-form-footer">
      {problem ? (
        <p role="alert" className="text-sm text-bad">
          {problem}
        </p>
      ) : null}
      <div className="connector-form-actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? "Saving…" : label}
        </Button>
      </div>
    </div>
  );
}
