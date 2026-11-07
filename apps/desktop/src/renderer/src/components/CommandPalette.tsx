import { Command } from "cmdk";
import { useEffect, useState, type ReactNode } from "react";
import { CoversPreview } from "../lib/browser-preview";
import { useRpc } from "../lib/client";
import { useOrclings } from "../lib/orclings";
import { paletteActions } from "../lib/palette-actions";
import { openTask, openThread, useRouter } from "../lib/router";
import { useUi } from "../lib/ui";
import { FolderGit2, MessageSquare, Orclings, Search } from "./icons";
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
  // Messages match by prefix from two characters on, across every thread's conversation.
  const hits = useRpc("threads.search", { query, limit: 20 }, { enabled: open && query.trim().length >= 2, staleTime: 5_000 });
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
        <Command className="command-palette" label="Command palette" shouldFilter={mode === "all"}>
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder={mode === "messages" ? "Search what was said in any thread…" : "Search threads, tasks, projects, messages, actions…"}
            className="command-palette-input native-field"
          />
          <Command.List className="command-palette-list">
            <Command.Empty className="px-3 py-6 text-center text-base text-ink-3">{emptySearchMessage(query, mode === "messages", hits.isFetching)}</Command.Empty>
            {(hits.data ?? []).length > 0 ? (
              <Command.Group heading="Messages" className="command-palette-group">
                {(hits.data ?? []).map((h) => (
                  <Command.Item
                    key={`${h.runId}-${h.messageId}`}
                    value={`message ${h.threadTitle} ${h.snippet} ${h.ts}`}
                    onSelect={() => {
                      const message = { runId: h.runId, turn: h.turn, messageId: h.messageId };
                      go(() => (h.taskId ? openTask(h.taskId, "chat", message) : openThread(h.threadId, message)));
                    }}
                    className="command-palette-item command-palette-hit"
                  >
                    <span className="flex items-center gap-2.5 min-w-0">
                      <Search size={14} className="command-palette-icon" />
                      <span className="truncate">{h.snippet}</span>
                    </span>
                    <span className="pl-6 text-sm text-ink-4 truncate">
                      {messageSender(h.role, h.member)} in {h.taskTitle ?? h.threadTitle}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            ) : null}
            {mode === "messages" ? null : (
              <Command.Group heading="Actions" className="command-palette-group">
                {paletteActions
                  .filter((action) => action.available?.() ?? true)
                  .map(({ label, icon: Icon, run }) => (
                    <Item key={label} onSelect={() => go(run)} icon={<Icon size={14} />}>
                      {label}
                    </Item>
                  ))}
              </Command.Group>
            )}
            {mode === "all" ? <PlaceGroups go={go} /> : null}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}

type Place = { key: string; value: string; label: string; icon: ReactNode; open: () => void };

function PlaceGroup({ heading, places, go }: { heading: string; places: Place[]; go: (fn: () => void) => void }) {
  if (!places.length) return null;
  return (
    <Command.Group heading={heading} className="command-palette-group">
      {places.map((place) => (
        <Item key={place.key} value={place.value} onSelect={() => go(place.open)} icon={place.icon}>
          {place.label}
        </Item>
      ))}
    </Command.Group>
  );
}

/** Threads, Orclings, tasks and projects by name. An Orcling's own conversation is listed under its name, as the sidebar lists it. */
function PlaceGroups({ go }: { go: (fn: () => void) => void }) {
  const tasks = useRpc("tasks.list", {}).data ?? [];
  const threads = useRpc("threads.list", { limit: 40, excludeSubagents: true }).data ?? [];
  const projects = useRpc("projects.list", {}).data ?? [];
  const orclings = useOrclings();
  const navigate = useRouter((s) => s.navigate);
  const homes = new Set(orclings.map((orcling) => orcling.threadId));
  return (
    <>
      <PlaceGroup
        heading="Threads"
        go={go}
        places={threads.filter((t) => !homes.has(t.id)).map((t) => ({ key: t.id, value: `thread ${t.title}`, label: t.title, icon: <MessageSquare size={14} />, open: () => openThread(t.id) }))}
      />
      <PlaceGroup
        heading="Orclings"
        go={go}
        places={orclings.map((o) => ({ key: o.id, value: `orcling ${o.name}`, label: o.name, icon: <Orclings size={14} />, open: () => openThread(o.threadId) }))}
      />
      <PlaceGroup heading="Tasks" go={go} places={tasks.map((t) => ({ key: t.id, value: `task ${t.title}`, label: t.title, icon: <StatusIcon status={t.status} />, open: () => openTask(t.id) }))} />
      <PlaceGroup
        heading="Projects"
        go={go}
        places={projects.map((p) => ({ key: p.id, value: `project ${p.name}`, label: p.name, icon: <FolderGit2 size={14} />, open: () => navigate({ view: "project", projectId: p.id }) }))}
      />
    </>
  );
}

function Item({ children, icon, onSelect, value }: { children: ReactNode; icon: ReactNode; onSelect: () => void; value?: string }) {
  return (
    <Command.Item value={value} onSelect={onSelect} className="command-palette-item">
      <span className="command-palette-icon">{icon}</span>
      <span className="truncate">{children}</span>
    </Command.Item>
  );
}
