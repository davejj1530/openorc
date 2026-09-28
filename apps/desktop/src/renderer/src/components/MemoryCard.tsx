import { useState } from "react";
import type { Memory, MemorySource } from "@openorc/protocol";
import { Check, MoreHorizontal, Pencil, ThumbsUp, Trash2, Upload, X } from "./icons";
import { Menu } from "@base-ui/react/menu";
import { memoryTypeLabel, MemoryTypeIcon } from "./memory";
import { Badge, Button, Input, Textarea } from "./ui";
import { cn } from "../lib/cn";
import { useRpcMutation } from "../lib/query";
import { relativeTime } from "../lib/time";
import { CoversPreview } from "../lib/browser-preview";
import "./memory.css";

export const memorySourceLabel: Record<MemorySource, string> = { agent: "Saved by an agent", extraction: "Learned after a run", user: "Saved by you", tool: "Saved by a tool" };

/** One memory: type, title, body, provenance, and the actions that curate it. */
export function MemoryCard({ memory }: { memory: Memory }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(memory.title);
  const [body, setBody] = useState(memory.body);
  const update = useRpcMutation("memory.update");
  const feedback = useRpcMutation("memory.feedback");
  const remove = useRpcMutation("memory.remove");
  const promote = useRpcMutation("memory.promote");
  const [note, setNote] = useState<string | null>(null);
  const dim = memory.status !== "active";
  const error = update.error ?? feedback.error ?? remove.error ?? promote.error;
  const busy = update.isPending || feedback.isPending || remove.isPending || promote.isPending;

  return (
    <article className="memory-entry" aria-label={memory.title} aria-busy={busy}>
      <div className="flex items-center gap-2 mb-1">
        <MemoryTypeIcon type={memory.type} />
        <span className="text-sm text-ink-2">{memoryTypeLabel[memory.type]}</span>
        {memory.status !== "active" ? <Badge tone="bad">{memory.status}</Badge> : null}
        <span className="flex-1" />
        <Actions
          title={memory.title}
          disabled={busy}
          onEdit={() => {
            setTitle(memory.title);
            setBody(memory.body);
            update.reset();
            setEditing(true);
          }}
          onHelpful={() => feedback.mutate({ id: memory.id, projectId: memory.projectId ?? "", verdict: "helpful" }, { onSuccess: () => setNote("marked helpful") })}
          onRetract={() => feedback.mutate({ id: memory.id, projectId: memory.projectId ?? "", verdict: "wrong" })}
          onDelete={() => remove.mutate({ id: memory.id, projectId: memory.projectId ?? "" })}
          onPromote={(file) => promote.mutate({ id: memory.id, file }, { onSuccess: (r) => setNote(`added to ${r.file}`) })}
        />
      </div>
      {editing ? (
        <div className="grid gap-2">
          <Input aria-label="Memory title" value={title} onChange={(e) => setTitle(e.target.value)} className="h-7 font-medium" />
          <Textarea aria-label="Memory details" rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={update.isPending || !title.trim() || !body.trim()}
              onClick={() => update.mutate({ id: memory.id, projectId: memory.projectId ?? "", patch: { title: title.trim(), body: body.trim() } }, { onSuccess: () => setEditing(false) })}
            >
              <Check size={12} /> Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setTitle(memory.title);
                setBody(memory.body);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          <h3 className={cn("memory-entry-title text-md font-medium", dim ? "text-ink-2" : "text-ink")}>{memory.title}</h3>
          <p className={cn("memory-entry-body text-base mt-1 whitespace-pre-wrap", dim ? "text-ink-3" : "text-ink-2")}>{memory.body}</p>
        </>
      )}
      <div className="memory-entry-meta">
        <span>{memorySourceLabel[memory.source]}</span>
        <time dateTime={new Date(memory.createdAt).toISOString()} title={new Date(memory.createdAt).toLocaleString()}>
          Created {relativeTime(memory.createdAt)}
        </time>
        {memory.updatedAt > memory.createdAt && (
          <time dateTime={new Date(memory.updatedAt).toISOString()} title={new Date(memory.updatedAt).toLocaleString()}>
            Updated {relativeTime(memory.updatedAt)}
          </time>
        )}
        {memory.lastConfirmedAt > memory.createdAt && (
          <time dateTime={new Date(memory.lastConfirmedAt).toISOString()} title={new Date(memory.lastConfirmedAt).toLocaleString()}>
            Confirmed {relativeTime(memory.lastConfirmedAt)}
          </time>
        )}
        {memory.evidenceCount > 1 && <span>{memory.evidenceCount} saved references</span>}
      </div>
      {memory.topicKey && (
        <p className="text-sm text-ink-3 mt-2">
          Topic: <span className="font-mono">{memory.topicKey}</span>
        </p>
      )}
      {memory.files.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {memory.files.map((f) => (
            <span key={f} className="text-xs font-mono text-ink-4">
              {f}
            </span>
          ))}
        </div>
      ) : null}
      {note ? (
        <div className="text-sm text-ink-2 mt-2" role="status">
          {note}
        </div>
      ) : null}
      {error && (
        <p className="text-sm text-bad mt-2" role="alert">
          Could not update this memory. {error.message}
        </p>
      )}
    </article>
  );
}

function Actions({
  title,
  disabled,
  onEdit,
  onHelpful,
  onRetract,
  onDelete,
  onPromote,
}: {
  title: string;
  disabled: boolean;
  onEdit: () => void;
  onHelpful: () => void;
  onRetract: () => void;
  onDelete: () => void;
  onPromote: (file: "CLAUDE.md" | "AGENTS.md") => void;
}) {
  const item = "flex items-center gap-2 h-7 px-2 rounded-md text-base text-ink-2 cursor-pointer data-[highlighted]:bg-surface-2 outline-none";
  return (
    <Menu.Root>
      <Menu.Trigger aria-label={`Actions for ${title}`} disabled={disabled} className="text-ink-3 hover:text-ink rounded-md p-1">
        <MoreHorizontal size={14} />
      </Menu.Trigger>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner sideOffset={4} align="end" collisionPadding={8}>
          <Menu.Popup className="menu-popup min-w-44 rounded-lg border border-line bg-surface p-1 shadow-panel outline-none">
            <Menu.Item className={item} onClick={onEdit}>
              <Pencil size={13} /> Edit
            </Menu.Item>
            <Menu.Item className={item} onClick={onHelpful}>
              <ThumbsUp size={13} /> Mark helpful
            </Menu.Item>
            <Menu.Item className={item} onClick={() => onPromote("CLAUDE.md")}>
              <Upload size={13} /> Add to CLAUDE.md
            </Menu.Item>
            <Menu.Item className={item} onClick={() => onPromote("AGENTS.md")}>
              <Upload size={13} /> Add to AGENTS.md
            </Menu.Item>
            <Menu.Separator className="my-1 h-px bg-line" />
            <Menu.Item className={item} onClick={onRetract}>
              <X size={13} /> Retract
            </Menu.Item>
            <Menu.Item className={cn(item, "text-bad")} onClick={onDelete}>
              <Trash2 size={13} /> Delete
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
