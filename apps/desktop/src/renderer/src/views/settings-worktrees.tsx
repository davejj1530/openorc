import { formatBytes, relativeTime, threadResolved } from "@openorc/client";
import { WORKTREE_BLOCK_WORDS, type WorktreeEntry, type WorktreeOwner, type WorktreeRemoval } from "@openorc/protocol";
import { useState } from "react";
import { WORKTREE_REMOVAL_NOTE } from "../components/RemoveWorktreeDialog";
import { Button, Checkbox, Dialog } from "../components/ui";
import { useRpc, useRpcMutation } from "../lib/client";
import { SettingRow } from "./settings-shared";
import "./settings-worktrees.css";
import { thisComputer } from "../lib/this-computer";

const ownerKey = (owner: WorktreeOwner) => `${owner.kind}:${owner.id}`;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const totalBytes = (rows: readonly WorktreeEntry[]) => rows.reduce((sum, row) => sum + row.bytes, 0);

function byProject(rows: readonly WorktreeEntry[]): WorktreeEntry[][] {
  const groups = new Map<string, WorktreeEntry[]>();
  for (const row of rows) groups.set(row.projectId, [...(groups.get(row.projectId) ?? []), row]);
  return [...groups.values()];
}

/** Put away in the sidebar's Resolved, or its pull request is done with: the ones worth suggesting. */
function suggested(row: WorktreeEntry, now: number): boolean {
  return row.blocked === null && (threadResolved(row, now) || row.prState === "merged" || row.prState === "closed");
}

/** The worktrees on this Mac in Local storage; nothing while there are none. */
export function WorktreesRow() {
  const list = useRpc("worktrees.list", {}, { staleTime: 60_000 });
  const [open, setOpen] = useState(false);
  const rows = list.data?.worktrees ?? [];
  if (!rows.length) return null;
  return (
    <div className="settings-worktrees">
      <SettingRow label="Worktrees" hint={`${plural(rows.length, "worktree")} · ${formatBytes(totalBytes(rows))}`}>
        <Button size="sm" onClick={() => setOpen(true)}>
          Clean up…
        </Button>
      </SettingRow>
      {open ? <WorktreeCleanupDialog onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

function WorktreeCleanupDialog({ onClose }: { onClose: () => void }) {
  const list = useRpc("worktrees.list", {}, { staleTime: 0 });
  const remove = useRpcMutation("worktrees.remove");
  const rows = list.data?.worktrees ?? [];
  // Suggestions are made once, from the first list, so a refresh never ticks a box the person cleared.
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const [outcome, setOutcome] = useState<{ result: WorktreeRemoval; titles: Map<string, string> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = Date.now();
  const selected = chosen ?? (list.data ? new Set(rows.filter((row) => suggested(row, now)).map((row) => ownerKey(row.owner))) : new Set<string>());
  const picked = rows.filter((row) => row.blocked === null && selected.has(ownerKey(row.owner)));
  const toggle = (row: WorktreeEntry, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(ownerKey(row.owner));
    else next.delete(ownerKey(row.owner));
    setChosen(next);
  };
  const close = () => {
    if (!remove.isPending) onClose();
  };
  const submit = async () => {
    if (!picked.length || remove.isPending) return;
    setError(null);
    const titles = new Map(picked.map((row) => [ownerKey(row.owner), row.title]));
    try {
      const result = await remove.mutateAsync({ owners: picked.map((row) => row.owner) });
      setChosen(new Set(result.failed.map((failure) => ownerKey(failure.owner))));
      if (result.failed.length) setOutcome({ result, titles });
      else onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const projects = byProject(rows);
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : close())} title="Clean up worktrees" width={600}>
      <div>
        <p className="text-sm text-ink-2 mb-4">{WORKTREE_REMOVAL_NOTE}</p>
        {list.isPending ? (
          <p role="status" className="text-sm text-ink-3 mb-3">
            Measuring worktrees…
          </p>
        ) : null}
        {list.data && !rows.length ? <p className="text-sm text-ink-3 mb-3">No worktrees left on {thisComputer}.</p> : null}
        <div className="worktree-cleanup-list">
          {projects.map((group) => (
            <section key={group[0]!.projectId} className="worktree-cleanup-project">
              <h3>{group[0]!.projectName}</h3>
              <div className="worktree-cleanup-rows">
                {group.map((row) => (
                  <WorktreeRow key={ownerKey(row.owner)} row={row} checked={row.blocked === null && selected.has(ownerKey(row.owner))} onChange={(on) => toggle(row, on)} now={now} />
                ))}
              </div>
            </section>
          ))}
        </div>
        {outcome ? (
          <div role="alert" className="text-sm text-bad mt-3 break-words">
            <p>{outcome.result.removed.length ? `Removed ${plural(outcome.result.removed.length, "worktree")}. These stayed:` : "These worktrees stayed:"}</p>
            <ul className="mt-1">
              {outcome.result.failed.map((failure) => (
                <li key={ownerKey(failure.owner)}>
                  {outcome.titles.get(ownerKey(failure.owner)) ?? "A worktree"}: {failure.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-bad mt-3 break-words">
            {error}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button disabled={remove.isPending} onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" disabled={remove.isPending || !picked.length} onClick={() => void submit()}>
            {remove.isPending ? "Removing…" : `Remove ${plural(picked.length, "worktree")} · ${formatBytes(totalBytes(picked))}`}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function WorktreeRow({ row, checked, onChange, now }: { row: WorktreeEntry; checked: boolean; onChange: (on: boolean) => void; now: number }) {
  const reason = row.blocked ? WORKTREE_BLOCK_WORDS[row.blocked] : undefined;
  return (
    <label className="worktree-cleanup-row" data-blocked={row.blocked ? "" : undefined} data-tip={reason}>
      <Checkbox checked={checked} disabled={Boolean(row.blocked)} onChange={(event) => onChange(event.target.checked)} />
      <span className="worktree-cleanup-name">
        <span>{row.title}</span>
        <span className="worktree-cleanup-meta">{[row.branch, relativeTime(row.lastActivityAt, now)].filter(Boolean).join(" · ")}</span>
      </span>
      <span className="worktree-cleanup-size tabular">{formatBytes(row.bytes)}</span>
    </label>
  );
}
