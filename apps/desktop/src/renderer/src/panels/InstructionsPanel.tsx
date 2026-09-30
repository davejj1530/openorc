import { useState, type KeyboardEvent } from "react";
import type { InstructionFile } from "@openorc/protocol";
import { Button, Segmented, Textarea } from "../components/ui";
import { readDraft, removeDraft, writeDraft } from "../lib/drafts";
import { queryClient, useRpc, useRpcMutation } from "../lib/query";

/** Unsaved text, with the version of the file it started from. */
type Draft = { content: string; version: string | null };

const draftKey = (path: string) => `instructions.${path}`;
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;
/** The personal file shares a project file's name, so it goes by where it applies. */
const fileLabel = (file: InstructionFile) => (file.scope === "personal" ? "Personal" : fileName(file.path));
const fileTitle = (file: InstructionFile) => (file.scope === "personal" ? `Personal ${fileName(file.path)}` : fileName(file.path));

/** The instruction files the thread's agent reads, AGENTS.md first, edited as plain Markdown. */
export function InstructionsPanel({ threadId }: { threadId: string }) {
  const list = useRpc("instructions.list", { threadId });
  const [selected, select] = useState<string | null>(null);
  const files = list.data ?? [];
  const file = files.find((candidate) => candidate.path === selected) ?? files[0];
  if (list.isLoading) {
    return (
      <p role="status" className="p-4 text-sm text-ink-3">
        Loading instructions…
      </p>
    );
  }
  if (list.error || !file) {
    return (
      <div role="status" className="p-4 text-sm text-ink-3">
        <p>{list.error?.message ?? "No instruction files for this agent."}</p>
        <Button className="mt-3" size="sm" onClick={() => void list.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  return <InstructionEditor threadId={threadId} files={files} file={file} onSelect={select} onRefused={() => void list.refetch()} />;
}

/** Unsaved text per file. Local storage keeps it when the reader leaves the conversation before saving. */
function useDrafts() {
  const [drafts, setDrafts] = useState<Record<string, Draft | null>>({});
  const draftFor = (path: string) => (path in drafts ? (drafts[path] ?? null) : readDraft<Draft | null>(draftKey(path), null));
  const keep = (path: string, next: Draft | null) => {
    setDrafts((current) => ({ ...current, [path]: next }));
    if (next) writeDraft(draftKey(path), next);
    else removeDraft(draftKey(path));
  };
  return { draftFor, keep };
}

function InstructionEditor({
  threadId,
  files,
  file,
  onSelect,
  onRefused,
}: {
  threadId: string;
  files: InstructionFile[];
  file: InstructionFile;
  onSelect: (path: string) => void;
  onRefused: () => void;
}) {
  const save = useRpcMutation("instructions.save");
  const { draftFor, keep } = useDrafts();
  const name = fileName(file.path);
  const draft = draftFor(file.path);
  const dirty = draft !== null && draft.content !== file.content;
  // The file changed on disk after editing began, often because the agent edited it.
  const stale = dirty && draft.version !== file.version;
  const edit = (content: string) => {
    save.reset();
    keep(file.path, content === file.content ? null : { content, version: draft ? draft.version : file.version });
  };
  const keepMine = () => draft && keep(file.path, { content: draft.content, version: file.version });
  const submit = () => {
    if (!draft || !dirty || stale || save.isPending) return;
    const path = file.path;
    save.mutate(
      { threadId, path, content: draft.content, version: draft.version },
      {
        onSuccess: (saved) => {
          queryClient.setQueryData<InstructionFile[]>(["instructions.list", { threadId }], (current) => current?.map((candidate) => (candidate.path === saved.path ? saved : candidate)));
          keep(path, null);
        },
        // Refused because the file moved on: reading it again shows the newer version.
        onError: onRefused,
      },
    );
  };
  const saveShortcut = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
    event.preventDefault();
    submit();
  };

  return (
    <section aria-label="Instructions" className="h-full min-h-0 flex flex-col">
      <header className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-line">
        <Segmented size="sm" label="Instruction file" value={file.path} onChange={onSelect} options={files.map((candidate) => ({ value: candidate.path, label: fileLabel(candidate) }))} />
        <span className="flex-1" />
        <Button size="sm" disabled={!dirty || stale || save.isPending} onClick={submit}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </header>
      <p className="shrink-0 truncate px-3 pt-2 text-xs text-ink-3" title={file.path}>
        {file.path}
      </p>
      {stale ? (
        <div role="status" className="shrink-0 flex flex-wrap items-center gap-2 px-3 pt-2 text-sm text-ink-2">
          <span className="min-w-0 flex-1">{name} changed after you started editing.</span>
          <Button size="sm" onClick={keepMine}>
            Keep mine
          </Button>
          <Button size="sm" onClick={() => keep(file.path, null)}>
            Use new version
          </Button>
        </div>
      ) : null}
      {save.error && !stale && save.variables?.path === file.path ? (
        <p role="alert" className="shrink-0 px-3 pt-2 text-sm text-bad">
          {save.error.message}
        </p>
      ) : null}
      <Textarea
        aria-label={fileTitle(file)}
        className="flex-1 min-h-0 rounded-none border-0 bg-transparent px-3 py-3 font-mono text-sm"
        value={draft?.content ?? file.content}
        placeholder={file.version === null ? `No ${name} yet` : undefined}
        spellCheck={false}
        onChange={(event) => edit(event.target.value)}
        onKeyDown={saveShortcut}
      />
    </section>
  );
}
