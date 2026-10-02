import { useState } from "react";
import type { Orcling, OrclingInstructionsVersion } from "@openorc/protocol";
import { MemoryCard } from "../components/MemoryCard";
import { OrclingAvatar } from "../components/OrclingAvatar";
import { Pencil } from "../components/icons";
import { Button, Empty, Textarea, TextButton } from "../components/ui";
import { orclingById, useOrclings } from "../lib/orclings";
import { useRpc, useRpcMutation } from "../lib/query";
import { useRouter } from "../lib/router";
import { relativeTime } from "../lib/time";
import { modelLabel } from "../lib/model-effort-label";
import { useModelCatalog } from "../lib/use-model-catalog";

/** An Orcling's profile beside a conversation it works in: its instructions, with every earlier version, and what it remembers. */
export function OrclingPanel({ orclingId }: { orclingId: string }) {
  const orcling = orclingById(useOrclings(), orclingId);
  const models = useModelCatalog();
  if (!orcling) return <Empty title="This Orcling was deleted">Its conversation history stays here.</Empty>;
  return (
    <div className="h-full min-h-0 overflow-y-auto p-3 grid gap-5 content-start">
      <header className="flex items-center gap-3">
        <OrclingAvatar orcling={orcling} size={44} />
        <div className="min-w-0 flex-1">
          <h2 className="text-md font-semibold text-ink truncate">{orcling.name}</h2>
          <p className="text-sm text-ink-3 truncate">
            {modelLabel(orcling.settings, models.data)} · {orcling.permission === "allow" ? "Allow" : "Approve"}
          </p>
        </div>
        <Button size="sm" onClick={() => useRouter.getState().navigate({ view: "orcling", orclingId: orcling.id })}>
          <Pencil size={12} /> Edit
        </Button>
      </header>
      <Instructions orcling={orcling} />
      <Memories orcling={orcling} />
    </div>
  );
}

function Instructions({ orcling }: { orcling: Orcling }) {
  const versions = useRpc("orclings.instructions", { id: orcling.id });
  const current = versions.data?.[0];
  return (
    <section className="grid gap-2" aria-label="Instructions">
      <h3 className="text-sm font-medium text-ink-2">Instructions</h3>
      {current ? <InstructionsEditor key={current.version} orcling={orcling} current={current} /> : null}
      {versions.data && versions.data.length > 1 ? <History orcling={orcling} versions={versions.data} /> : null}
    </section>
  );
}

function InstructionsEditor({ orcling, current }: { orcling: Orcling; current: OrclingInstructionsVersion }) {
  const [body, setBody] = useState(current.body);
  const save = useRpcMutation("orclings.instructions.save");
  const changed = body.trim() !== current.body.trim();
  return (
    <div className="grid gap-2">
      <Textarea aria-label={`${orcling.name}'s instructions`} rows={8} value={body} onChange={(event) => setBody(event.target.value)} className="font-mono text-sm" />
      <div className="flex items-center gap-2">
        <Button size="sm" variant="primary" disabled={!changed || save.isPending} onClick={() => save.mutate({ id: orcling.id, body })}>
          Save
        </Button>
        {changed ? (
          <Button size="sm" variant="ghost" onClick={() => setBody(current.body)}>
            Discard
          </Button>
        ) : null}
        <span className="flex-1" />
        <span className="text-xs text-ink-4">
          Version {current.version} · {current.author === "orcling" ? orcling.name : "You"} · {relativeTime(current.createdAt)}
        </span>
      </div>
      {save.error ? (
        <p role="alert" className="text-sm text-bad">
          {save.error.message}
        </p>
      ) : null}
    </div>
  );
}

/** Earlier versions, newest first. Restoring one saves it again as the newest, so nothing is lost. */
function History({ orcling, versions }: { orcling: Orcling; versions: OrclingInstructionsVersion[] }) {
  const restore = useRpcMutation("orclings.instructions.restore");
  return (
    <ol className="grid gap-1" aria-label="Earlier versions">
      {versions.slice(1).map((version) => (
        <li key={version.version} className="flex items-baseline gap-2 text-sm text-ink-3">
          <span className="tabular text-ink-4">v{version.version}</span>
          <span className="min-w-0 flex-1 truncate" title={version.note ?? undefined}>
            {version.author === "orcling" ? orcling.name : "You"}
            {version.note ? ` · ${version.note}` : ""}
          </span>
          <span className="tabular text-ink-4">{relativeTime(version.createdAt)}</span>
          <TextButton tone="muted" disabled={restore.isPending} onClick={() => restore.mutate({ id: orcling.id, version: version.version })}>
            Restore
          </TextButton>
        </li>
      ))}
    </ol>
  );
}

function Memories({ orcling }: { orcling: Orcling }) {
  const memories = useRpc("orclings.memories", { id: orcling.id });
  const items = memories.data ?? [];
  return (
    <section className="grid gap-2" aria-label="Memory">
      <h3 className="text-sm font-medium text-ink-2">Memory</h3>
      {!memories.isLoading && items.length === 0 ? <p className="text-sm text-ink-3">Nothing remembered yet.</p> : null}
      {items.map((memory) => (
        <MemoryCard key={memory.id} memory={memory} />
      ))}
    </section>
  );
}
