import { Command } from "cmdk";
import { FolderGit2, MessageSquare, Search } from "./icons";
import { useEffect, useState } from "react";
import { paletteActions } from "../lib/palette-actions";
import { useRpc } from "../lib/query";
import { openTask, openThread, useRouter } from "../lib/router";
import { useUi } from "../lib/ui";
import { CoversPreview } from "../lib/browser-preview";
import { StatusIcon } from "./status";

function emptySearchMessage(query: string, messageMode: boolean, fetching: boolean): string {
  if (query.trim().length < 2 && messageMode) return "Type two or more characters.";
  if (fetching) return "Searching…";
  return "Nothing matches.";
}

function messageSender(role: string, member: { name: string } | null | undefined): string {
  if (role === "user") return "You";
  if (member) return member.name;
  return "Agent";
}

function usePaletteKeys(open: boolean, onOpenChange: (open: boolean) => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenChange(!open);
      }
      if (open && e.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);
}

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const mode = useUi((s) => s.paletteMode);
  const [query, setQuery] = useState("");
  const tasks = useRpc("tasks.list", {}, { enabled: open && mode === "all" });
  const threads = useRpc("threads.list", { limit: 40 }, { enabled: open && mode === "all" });
  const projects = useRpc("projects.list", {}, { enabled: open && mode === "all" });
  // Messages match by prefix from two characters on, across every thread's conversation.
  const hits = useRpc("threads.search", { query, limit: 20 }, { enabled: open && query.trim().length >= 2, staleTime: 5_000 });
  const navigate = useRouter((s) => s.navigate);
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);
  usePaletteKeys(open, onOpenChange);

  if (!open) return null;
  const go = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/30" onMouseDown={() => onOpenChange(false)}>
      <CoversPreview />
      <div className="absolute left-1/2 top-1/5 -translate-x-1/2 w-full max-w-palette" onMouseDown={(e) => e.stopPropagation()}>
        <Command className="rounded-lg border border-line bg-surface shadow-modal overflow-hidden" label="Command palette" shouldFilter={mode === "all"}>
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder={mode === "messages" ? "Search what was said in any thread…" : "Search threads, tasks, projects, messages, actions…"}
            className="w-full h-11 px-4 bg-transparent border-0 border-b border-line text-md outline-none placeholder:text-ink-4"
          />
          <Command.List className="max-h-96 overflow-y-auto p-1.5">
            <Command.Empty className="px-3 py-6 text-center text-base text-ink-3">{emptySearchMessage(query, mode === "messages", hits.isFetching)}</Command.Empty>
            {(hits.data ?? []).length > 0 ? (
              <Command.Group
                heading="Messages"
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-ink-3 [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide"
              >
                {(hits.data ?? []).map((h) => (
                  <Command.Item
                    key={`${h.runId}-${h.ts}`}
                    value={`message ${h.threadTitle} ${h.snippet} ${h.ts}`}
                    onSelect={() => go(() => (h.taskId ? openTask(h.taskId, "chat") : openThread(h.threadId)))}
                    className="grid gap-0.5 px-2 py-1.5 rounded-md text-base text-ink-2 data-[selected=true]:bg-surface-2 data-[selected=true]:text-ink"
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <Search size={13} className="text-ink-3 shrink-0" />
                      <span className="truncate">{h.snippet}</span>
                    </span>
                    <span className="pl-5 text-xs text-ink-4 truncate">
                      {messageSender(h.role, h.member)} in {h.taskTitle ?? h.threadTitle}
                      {h.member && h.taskTitle ? ` (team: ${h.threadTitle})` : ""}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            ) : null}
            {mode === "messages" ? null : (
              <Command.Group
                heading="Actions"
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-ink-3 [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide"
              >
                {paletteActions
                  .filter((action) => action.available?.() ?? true)
                  .map(({ label, icon: Icon, run }) => (
                    <Item key={label} onSelect={() => go(run)} icon={<Icon size={14} />}>
                      {label}
                    </Item>
                  ))}
              </Command.Group>
            )}
            {mode === "all" && (threads.data ?? []).length > 0 ? (
              <Command.Group
                heading="Threads"
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-ink-3 [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide"
              >
                {(threads.data ?? []).map((t) => (
                  <Item key={t.id} value={`thread ${t.title}`} onSelect={() => go(() => openThread(t.id))} icon={<MessageSquare size={14} />}>
                    {t.title}
                  </Item>
                ))}
              </Command.Group>
            ) : null}
            {mode === "all" && (tasks.data ?? []).length > 0 ? (
              <Command.Group
                heading="Tasks"
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-ink-3 [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide"
              >
                {(tasks.data ?? []).map((t) => (
                  <Item key={t.id} value={`task ${t.title}`} onSelect={() => go(() => openTask(t.id))} icon={<StatusIcon status={t.status} />}>
                    {t.title}
                  </Item>
                ))}
              </Command.Group>
            ) : null}
            {mode === "all" && (projects.data ?? []).length > 0 ? (
              <Command.Group
                heading="Projects"
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-ink-3 [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide"
              >
                {(projects.data ?? []).map((p) => (
                  <Item key={p.id} value={`project ${p.name}`} onSelect={() => go(() => navigate({ view: "project", projectId: p.id }))} icon={<FolderGit2 size={14} />}>
                    {p.name}
                  </Item>
                ))}
              </Command.Group>
            ) : null}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}

function Item({ children, icon, onSelect, value }: { children: React.ReactNode; icon: React.ReactNode; onSelect: () => void; value?: string }) {
  return (
    <Command.Item value={value} onSelect={onSelect} className="flex items-center gap-2 h-8 px-2 rounded-md text-base text-ink-2 data-[selected=true]:bg-surface-2 data-[selected=true]:text-ink">
      <span className="text-ink-3">{icon}</span>
      <span className="truncate">{children}</span>
    </Command.Item>
  );
}
