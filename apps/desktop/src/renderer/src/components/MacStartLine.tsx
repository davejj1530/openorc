import { useState, type ReactNode } from "react";
import type { MacStartPlan } from "@openorc/protocol";
import { useRpc } from "../lib/client";
import { Laptop } from "./icons";
import { Checkbox, TextButton } from "./ui";

const card = "rounded-xl bg-surface px-3.5 py-1.5 text-base";
type Ready = Extract<MacStartPlan, { state: "ready" }>;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** New files, said shortly after changed ones ("3 changed files and 1 new"). */
function newFiles(plan: Ready): string | null {
  if (!plan.added.length) return null;
  return plan.changed.length ? `${plan.added.length} new` : plural(plan.added.length, "new file", "new files");
}

/** What goes, in a few words: commits, changed files, new ones, and the packed size. */
function goes(plan: Ready): string {
  const parts = [
    plan.commits.length ? plural(plan.commits.length, "commit", "commits") : null,
    plan.changed.length ? plural(plan.changed.length, "changed file", "changed files") : null,
    newFiles(plan),
  ].filter(Boolean);
  const listed = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? "Nothing");
  return `From this Mac: ${listed} · ${size(plan.bytes)}`;
}

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function Group({ title, items, children }: { title: string; items: readonly string[]; children?: (item: string) => ReactNode }) {
  if (!items.length) return null;
  return (
    <div className="grid py-1.5">
      <div className="pb-0.5 text-xs text-ink-4">{title}</div>
      {items.map((item) => (
        <div key={item} className="flex min-h-6 items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{item}</span>
          {children?.(item)}
        </div>
      ))}
    </div>
  );
}

/**
 * A new cloud thread from this Mac's project folder: the line above Start that says what goes, read on this Mac before
 * anything leaves, its files on demand, and the held-back ones the person may send after all. Answers the line, the
 * start's `macWork`, and why Start can't go.
 */
export function useMacStart(projectId: string | null, spaceId: string | undefined, on: boolean): { line: ReactNode; macWork: { include: string[] } | undefined; refusal: string | null } {
  const [include, setInclude] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const plan = useRpc(
    "hostedMacStart.plan",
    { projectId: projectId ?? "", ...(spaceId && { spaceId }), include },
    { enabled: on && Boolean(projectId), staleTime: 0, placeholderData: (previous) => previous },
  );
  const data = on ? plan.data : undefined;
  if (data?.state !== "ready") return { line: null, macWork: undefined, refusal: null };
  if (data.refusal)
    return {
      line: (
        <section role="status" aria-label="From this Mac" className={card}>
          <div className="py-1.5 text-bad">{data.refusal}</div>
        </section>
      ),
      macWork: { include },
      refusal: data.refusal,
    };
  const toggle = (file: string, sent: boolean) => setInclude((now) => (sent ? [...now, file] : now.filter((one) => one !== file)));
  const included = include.filter((file) => data.added.includes(file));
  const held = [...data.held, ...included].sort();
  return {
    line: (
      <section role="status" aria-label="From this Mac" className={card}>
        <div className="flex items-center gap-3 py-1">
          <Laptop size={14} className="shrink-0 text-ink-4" />
          <span className="min-w-0 flex-1 text-ink">
            {goes(data)}
            {data.held.length ? (
              <span className="text-ink-4" data-tip="They look like secrets.">
                {" "}
                · {data.held.length} held back
              </span>
            ) : null}
          </span>
          <TextButton tone="muted" onClick={() => setOpen(!open)}>
            {open ? "Hide files" : "Files"}
          </TextButton>
        </div>
        {open ? (
          <div className="divide-y divide-line border-t border-line">
            <Group title="Commits" items={data.commits.map((commit) => `${commit.sha.slice(0, 7)} ${commit.subject}`)} />
            <Group title="Changed" items={data.changed} />
            <Group title="New" items={data.added.filter((file) => !include.includes(file))} />
            <Group title="Held back" items={held}>
              {(file) => (
                <label className="flex items-center gap-2 text-xs text-ink-4" data-tip="It looks like a secret.">
                  Send
                  <Checkbox checked={include.includes(file)} onChange={(event) => toggle(file, event.target.checked)} aria-label={`Send ${file}`} />
                </label>
              )}
            </Group>
          </div>
        ) : null}
      </section>
    ),
    macWork: { include },
    refusal: null,
  };
}
