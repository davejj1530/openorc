import { useState } from "react";
import { orclingWakeKey, type Orcling, type OrclingWake } from "@openorc/protocol";
import { X } from "../components/icons";
import { IconButton, Input, Switch, TextButton } from "../components/ui";
import { useRpcMutation } from "../lib/client";

type TimeWake = Extract<OrclingWake, { kind: "time" }>;

const DAYS = [
  ["S", "Sunday"],
  ["M", "Monday"],
  ["T", "Tuesday"],
  ["W", "Wednesday"],
  ["T", "Thursday"],
  ["F", "Friday"],
  ["S", "Saturday"],
] as const;
const SUGGESTED = ["09:00", "13:00", "18:00", "21:00"];
const sameWakes = (a: OrclingWake[], b: OrclingWake[]) => a.map(orclingWakeKey).join(" ") === b.map(orclingWakeKey).join(" ");

function TimeRow({ wake, onChange, onRemove }: { wake: TimeWake; onChange: (next: TimeWake) => void; onRemove: () => void }) {
  const toggle = (day: number) => {
    const days = wake.days.includes(day) ? wake.days.filter((other) => other !== day) : [...wake.days, day].sort();
    if (days.length) onChange({ ...wake, days });
  };
  return (
    <div className="flex flex-wrap items-center gap-2 min-h-9">
      <Input
        type="time"
        aria-label="Time"
        value={wake.at}
        onChange={(event) => {
          if (/^\d\d:\d\d$/.test(event.target.value)) onChange({ ...wake, at: event.target.value });
        }}
        className="w-[124px] tabular"
      />
      <div role="group" aria-label="Days" className="flex gap-1">
        {DAYS.map(([letter, name], day) => (
          <button key={name} type="button" className="orcling-day" aria-label={name} aria-pressed={wake.days.includes(day)} onClick={() => toggle(day)}>
            {letter}
          </button>
        ))}
      </div>
      <IconButton aria-label={`Remove the ${wake.at} check-in`} onClick={onRemove} className="ml-auto">
        <X size={14} />
      </IconButton>
    </div>
  );
}

/**
 * When the Orcling wakes up on its own to see whether anything is worth texting about. Every change saves at once, and
 * builds on the last one sent rather than on the saved list, so quick changes in a row never undo each other.
 */
export function OrclingWakes({ orcling }: { orcling: Orcling }) {
  const save = useRpcMutation("orclings.wakes.save");
  const [sent, setSent] = useState<OrclingWake[] | null>(null);
  if (sent && sameWakes(sent, orcling.wakes)) setSent(null);
  const current = sent ?? orcling.wakes;
  const commit = (wakes: OrclingWake[]) => {
    setSent(wakes);
    save.mutate({ id: orcling.id, wakes }, { onError: () => setSent(null) });
  };
  const opening = current.some((wake) => wake.kind === "startup");
  const times = current.filter((wake): wake is TimeWake => wake.kind === "time");
  const withOpening = (next: TimeWake[]) => commit(opening ? [{ kind: "startup" }, ...next] : next);
  const free = SUGGESTED.find((at) => !times.some((wake) => wake.at === at)) ?? "09:00";
  return (
    <section className="grid gap-1" aria-label="Check-ins">
      <h3 className="text-base text-ink">Check-ins</h3>
      <label className="flex items-center gap-3 h-9 text-sm text-ink-2">
        <span className="flex-1">When OpenOrc opens</span>
        <Switch checked={opening} onChange={(event) => commit(event.target.checked ? [{ kind: "startup" }, ...times] : times)} />
      </label>
      {times.map((wake, index) => (
        <TimeRow
          key={index}
          wake={wake}
          onChange={(next) => withOpening(times.map((other, at) => (at === index ? next : other)))}
          onRemove={() => withOpening(times.filter((_, at) => at !== index))}
        />
      ))}
      <div>
        <TextButton tone="muted" onClick={() => withOpening([...times, { kind: "time", at: free, days: [1, 2, 3, 4, 5] }])}>
          Add a time
        </TextButton>
      </div>
      {save.error ? (
        <p role="alert" className="text-sm text-bad">
          {save.error.message}
        </p>
      ) : null}
    </section>
  );
}
