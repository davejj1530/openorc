import { useEffect, useRef, useState } from "react";
import type { HostedEnvironmentVariable, SpaceProject } from "@openorc/protocol";
import { X } from "../components/icons";
import { Button, Dialog, IconButton, Input, TextButton } from "../components/ui";
import { cn } from "../lib/cn";
import { queryClient, useRpc, useRpcMutation } from "../lib/client";

type Project = SpaceProject & { hostedProjectId: string };
/** One row of the sheet: a saved variable shows its name and no value, and sends one only when it is typed over. */
type Row = { id: number; name: string; value: string; saved: boolean; problem?: string };
type Entry = { name: string; value: string };

const HELD = "Only an admin can change a project's environment.";
const UNAVAILABLE = "A project's environment isn't available in cloud threads yet.";
const words = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure));

/** A cloud project's own environment variables, which every turn in its cloud threads runs with. */
export function ProjectEnvironmentDialog({ spaceId, project, onClose }: { spaceId: string; project: Project; onClose(): void }) {
  const params = { spaceId, projectId: project.hostedProjectId };
  const read = useRpc("hostedEnvironment.read", params, { staleTime: 0 });
  const pending = useRef(false);
  return (
    <Dialog
      open
      title={`Environment of ${project.name}`}
      width={560}
      onOpenChange={(open) => {
        if (!open && !pending.current) onClose();
      }}
    >
      {read.data?.state === "ready" ? (
        <EnvironmentForm
          spaceId={spaceId}
          project={project}
          saved={read.data.variables}
          canChange={read.data.canChange}
          onClose={onClose}
          onPending={(value) => {
            pending.current = value;
          }}
        />
      ) : (
        <div className="grid justify-items-start gap-3">
          <p className="text-sm text-ink-3">{read.error?.message ?? (read.data ? UNAVAILABLE : "Loading…")}</p>
          {read.error ? <Button onClick={() => void read.refetch()}>Try again</Button> : null}
        </div>
      )}
    </Dialog>
  );
}

/** What the sheet holds before it is saved: its rows, the saved names taken out, and a line about the last action. */
function useEnvironmentDraft({ saved, canChange, project }: { saved: HostedEnvironmentVariable[]; canChange: boolean; project: Project }) {
  const nextId = useRef(0);
  const row = (name: string, value: string, isSaved = false): Row => ({ id: nextId.current++, name, value, saved: isSaved });
  const [rows, setRows] = useState<Row[]>(() => (saved.length ? saved.map((variable) => row(variable.name, "", true)) : [row("", "")]));
  const [removed, setRemoved] = useState<string[]>([]);
  const [said, setSaid] = useState<{ text: string; bad: boolean } | null>(null);
  const fromFile = useRpcMutation("hostedEnvironment.fromFile");
  const local = project.localProjectId;

  /** Each variable of the file replaces the value of a row with its name, or comes in as a row of its own. */
  const fillWith = (entries: Entry[]) => {
    if (!entries.length) return;
    setRows((current) => {
      const kept = current.filter((each) => each.saved || each.name || each.value);
      const byName = new Map(entries.map((entry) => [entry.name, entry.value]));
      const known = new Set(kept.map((each) => each.name));
      const merged = kept.map((each) => (byName.has(each.name) ? { ...each, value: byName.get(each.name)!, problem: undefined } : each));
      return [...merged, ...entries.filter((entry) => !known.has(entry.name)).map((entry) => row(entry.name, entry.value))];
    });
  };

  // A project with nothing saved starts from this Mac's .env, quietly: a folder with none starts with one empty row.
  const filled = useRef(false);
  useEffect(() => {
    if (filled.current || saved.length || !canChange || !local) return;
    filled.current = true;
    void fromFile
      .mutateAsync({ localProjectId: local })
      .then((found) => fillWith(found.entries))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, for the sheet's first read
  }, []);

  const toSet = rows.filter((each) => (each.saved ? each.value !== "" : each.name !== "" || each.value !== ""));
  return {
    rows,
    removed,
    said,
    toSet,
    local,
    changed: toSet.length > 0 || removed.length > 0,
    refused: rows.some((each) => each.problem),
    fail: (failure: unknown) => setSaid({ text: words(failure), bad: true }),
    quiet: () => setSaid(null),
    add: () => setRows((current) => [...current, row("", "")]),
    edit: (id: number, change: Partial<Row>) => setRows((current) => current.map((each) => (each.id === id ? { ...each, ...change, problem: undefined } : each))),
    take: (target: Row) => {
      setRows((current) => current.filter((each) => each.id !== target.id));
      if (target.saved) setRemoved((names) => [...names, target.name]);
    },
    fill: async () => {
      if (!local) return;
      try {
        const found = await fromFile.mutateAsync({ localProjectId: local });
        setSaid(found.entries.length ? null : { text: `No variables in ${project.name}'s .env.`, bad: false });
        fillWith(found.entries);
      } catch (failure) {
        setSaid({ text: words(failure), bad: true });
      }
    },
    /** The server's sentence for a refused name, under the row that has it; a new row before a saved one. */
    refuse: (name: string, message: string) => {
      const at = rows.find((each) => !each.saved && each.name === name) ?? rows.find((each) => each.name === name);
      if (at) setRows((current) => current.map((each) => (each.id === at.id ? { ...each, problem: message } : each)));
      else setSaid({ text: message, bad: true });
    },
    /** Kept by the server: saved rows now, so trying again after a failed removal sends them no second time. */
    keep: (names: Set<string>) => setRows((current) => current.map((each) => (names.has(each.name) ? { ...each, saved: true, value: "" } : each))),
    removedOne: (name: string) => setRemoved((names) => names.filter((each) => each !== name)),
  };
}

function EnvironmentForm({
  spaceId,
  project,
  saved,
  canChange,
  onClose,
  onPending,
}: {
  spaceId: string;
  project: Project;
  saved: HostedEnvironmentVariable[];
  canChange: boolean;
  onClose(): void;
  onPending(value: boolean): void;
}) {
  const params = { spaceId, projectId: project.hostedProjectId };
  const draft = useEnvironmentDraft({ saved, canChange, project });
  const set = useRpcMutation("hostedEnvironment.set");
  const remove = useRpcMutation("hostedEnvironment.remove");
  const busy = set.isPending || remove.isPending;

  const submit = async () => {
    if (busy || !draft.changed || draft.refused || !canChange) return;
    onPending(true);
    draft.quiet();
    try {
      if (draft.toSet.length) {
        const answer = await set.mutateAsync({ ...params, variables: draft.toSet.map(({ name, value }) => ({ name, value })) });
        if (answer.state === "refused") return draft.refuse(answer.name, answer.message);
        draft.keep(new Set(draft.toSet.map((each) => each.name)));
        queryClient.setQueryData(["hostedEnvironment.read", params], { ...answer, state: "ready" });
      }
      for (const name of draft.removed) {
        queryClient.setQueryData(["hostedEnvironment.read", params], await remove.mutateAsync({ ...params, name }));
        draft.removedOne(name);
      }
      onClose();
    } catch (failure) {
      draft.fail(failure);
    } finally {
      onPending(false);
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="grid gap-2">
        {draft.rows.map((each) => (
          <VariableRow key={each.id} row={each} canChange={canChange} busy={busy} onEdit={(change) => draft.edit(each.id, change)} onTake={() => draft.take(each)} />
        ))}
      </div>
      {canChange ? (
        <div className="mt-3 flex gap-3">
          <TextButton tone="muted" disabled={busy} onClick={draft.add}>
            Add variable
          </TextButton>
          {draft.local ? (
            <TextButton tone="muted" disabled={busy} onClick={() => void draft.fill()}>
              Fill from .env
            </TextButton>
          ) : null}
        </div>
      ) : null}
      {draft.said ? (
        <p role={draft.said.bad ? "alert" : "status"} className={cn("mt-3 text-sm break-words", draft.said.bad ? "text-bad" : "text-ink-3")}>
          {draft.said.text}
        </p>
      ) : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        {canChange ? (
          <Button type="submit" variant="primary" disabled={busy || !draft.changed || draft.refused}>
            Save
          </Button>
        ) : (
          <span data-tip={HELD} tabIndex={0}>
            <Button variant="primary" disabled>
              Save
            </Button>
          </span>
        )}
      </div>
    </form>
  );
}

function VariableRow({ row, canChange, busy, onEdit, onTake }: { row: Row; canChange: boolean; busy: boolean; onEdit(change: Partial<Row>): void; onTake(): void }) {
  const named = row.name || "the variable";
  return (
    <div className="grid gap-1">
      <div className="flex items-center gap-2">
        <Input
          variant="sheet"
          aria-label="Name"
          className="flex-1 font-mono"
          value={row.name}
          readOnly={!canChange || row.saved}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onEdit({ name: event.target.value })}
        />
        <Input
          variant="sheet"
          aria-label={`Value of ${named}`}
          className="flex-1"
          type="password"
          placeholder={row.saved ? "Saved" : "Value"}
          value={row.value}
          readOnly={!canChange}
          disabled={busy}
          autoComplete="off"
          onChange={(event) => onEdit({ value: event.target.value })}
        />
        {canChange ? (
          <IconButton aria-label={`Remove ${named}`} size="sm" disabled={busy} onClick={onTake}>
            <X size={14} />
          </IconButton>
        ) : null}
      </div>
      {row.problem ? (
        <p role="alert" className="text-sm text-bad">
          {row.problem}
        </p>
      ) : null}
    </div>
  );
}
