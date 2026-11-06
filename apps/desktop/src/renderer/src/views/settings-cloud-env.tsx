import { useState } from "react";
import { CLOUD_ENV_LIMITS, type CloudEnv } from "@openorc/protocol";
import { X } from "../components/icons";
import { Button, Dialog, IconButton, Input, TextButton } from "../components/ui";
import { queryClient, useRpc, useRpcMutation } from "../lib/client";
import { Failure } from "./settings-secret-field";

/**
 * One variable as the dialog edits it. A saved one shows no value: left empty under the name it was saved as, it keeps
 * what is saved, which a new name does not take with it.
 */
interface Row {
  key: number;
  name: string;
  value: string;
  savedAs: string | null;
}

let nextKey = 0;
const row = (name: string, value: string, saved: boolean): Row => ({ key: nextKey++, name, value, savedAs: saved ? name : null });
const keepsSaved = (each: Row) => each.savedAs !== null && each.savedAs === each.name.trim() && !each.value;

/** What a .env file holds, over the rows: a name already there takes the file's value, a new one is added. */
function filled(rows: Row[], entries: { name: string; value: string }[]): Row[] {
  const next = rows.filter((each) => each.name.trim() || each.value);
  for (const { name, value } of entries) {
    const at = next.findIndex((each) => each.name.trim() === name);
    if (at === -1) next.push(row(name, value, false));
    else next[at] = { ...next[at]!, value };
  }
  return next;
}

function EnvRows({ rows, setRows, disabled }: { rows: Row[]; setRows: (rows: Row[]) => void; disabled: boolean }) {
  const edit = (key: number, change: Partial<Row>) => setRows(rows.map((each) => (each.key === key ? { ...each, ...change } : each)));
  return (
    <div className="grid gap-2">
      {rows.map((each) => (
        <div key={each.key} className="flex items-center gap-2">
          <Input
            aria-label="Name"
            className="flex-1 font-mono"
            autoComplete="off"
            spellCheck={false}
            placeholder="NAME"
            value={each.name}
            disabled={disabled}
            onChange={(e) => edit(each.key, { name: e.target.value })}
          />
          <Input
            aria-label={`Value of ${each.name || "the variable"}`}
            className="flex-1"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={each.savedAs !== null && each.savedAs === each.name.trim() ? "Saved" : "Value"}
            value={each.value}
            disabled={disabled}
            onChange={(e) => edit(each.key, { value: e.target.value })}
          />
          <IconButton aria-label={`Remove ${each.name || "variable"}`} size="sm" disabled={disabled} onClick={() => setRows(rows.filter((other) => other.key !== each.key))}>
            <X size={14} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}

function EnvForm({ projectId, names, close }: { projectId: string; names: string[]; close: () => void }) {
  const [rows, setRows] = useState<Row[]>(() => (names.length ? names.map((name) => row(name, "", true)) : [row("", "", false)]));
  const [noFile, setNoFile] = useState(false);
  const save = useRpcMutation("cloud.env.set");
  const fromFile = useRpcMutation("cloud.env.fromFile");
  const busy = save.isPending || fromFile.isPending;
  const kept = rows.filter((each) => each.name.trim() || each.value);
  const submit = () =>
    save.mutate(
      { projectId, entries: kept.map((each) => ({ name: each.name.trim(), ...(keepsSaved(each) ? {} : { value: each.value }) })) },
      {
        onSuccess: (env: CloudEnv) => {
          queryClient.setQueryData(["cloud.env", { projectId }], env);
          close();
        },
      },
    );
  const fill = () =>
    fromFile.mutate(
      { projectId },
      {
        onSuccess: ({ files, entries }) => {
          setNoFile(!files.length);
          if (entries.length) setRows(filled(rows, entries));
        },
      },
    );
  return (
    <div className="space-y-3">
      <p className="text-ink-3">Cloud threads in this project and its setup script get these. The agent can read them, so use development values.</p>
      <EnvRows rows={rows} setRows={setRows} disabled={busy} />
      <div className="flex gap-3">
        <TextButton tone="muted" disabled={busy || rows.length >= CLOUD_ENV_LIMITS.entries} onClick={() => setRows([...rows, row("", "", false)])}>
          Add variable
        </TextButton>
        <TextButton tone="muted" disabled={busy} onClick={fill}>
          Fill from .env
        </TextButton>
      </div>
      {noFile ? <p className="text-ink-3">This project has no .env or .env.local.</p> : null}
      <Failure error={save.error ?? fromFile.error} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button variant="primary" disabled={busy} onClick={submit}>
          Save
        </Button>
      </div>
    </div>
  );
}

/** A project's environment for its cloud threads: names shown, values kept in protected storage and never shown again. */
export function CloudEnvButton({ project, disabled }: { project: { id: string; name: string }; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const env = useRpc("cloud.env", { projectId: project.id }, { enabled: open });
  return (
    <>
      <TextButton tone="muted" disabled={disabled} onClick={() => setOpen(true)}>
        Environment
      </TextButton>
      <Dialog open={open} onOpenChange={setOpen} title={`${project.name} environment`} width={560}>
        {env.data ? <EnvForm key={env.dataUpdatedAt} projectId={project.id} names={env.data.names} close={() => setOpen(false)} /> : <Failure error={env.error} />}
      </Dialog>
    </>
  );
}
