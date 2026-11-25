import { OrganizationPalette } from "./OrganizationPalette";
import { TeamChatPalette } from "./TeamChatPalette";
import { TeamChatSearchHits } from "./TeamChatSearchHits";
import { useOrganization } from "../lib/organization-context";
import { useSpaceProjects } from "../lib/space-queries";
import { Command } from "cmdk";
import { useEffect, useState, type ReactNode } from "react";
import { latestActivity, rowAge, useSidebarNow } from "@openorc/client";
import { isHarnessId, type ThreadSummary } from "@openorc/protocol";
import { CoversPreview } from "../lib/browser-preview";
import { useSpaceRpc as useRpc } from "../lib/space-queries";
import { useOrclingChatIds, useOrclings } from "../lib/orclings";
import { paletteActions } from "../lib/palette-actions";
import { openTask, openThread, useRouter } from "../lib/router";
import { useUi } from "../lib/ui";
import { HarnessLogo } from "./HarnessLogo";
import { MessageSquare, Orclings, Search } from "./icons";
import { ProjectLogo } from "./ProjectIconPicker";
import { StatusIcon } from "./status";
import { ThreadStatusIndicator } from "./ThreadStatusIndicator";
import { HostedPaletteUnavailable, usePaletteSearch } from "./HostedPaletteSearch";

/** Threads listed before a word is typed. */
const RECENT = 5;

function emptySearchMessage(query: string, messageMode: boolean, fetching: boolean): string {
  if (query.trim().length < 2 && messageMode) return "Type two or more characters.";
  if (fetching) return "Searching…";
  return "Nothing matches.";
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
  const organization = useOrganization();
  const mode = useUi((s) => s.paletteMode);
  const [query, setQuery] = useState("");
  const search = usePaletteSearch(open, query);
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);
  usePaletteKeys(open, onOpenChange);

  if (!open) return null;
  const go = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  const typed = query.trim().length > 0;
  return (
    <div className="fixed inset-0 z-50 bg-black/30" onMouseDown={() => onOpenChange(false)}>
      <CoversPreview />
      <div className="absolute left-1/2 top-1/6 -translate-x-1/2 w-full max-w-palette" onMouseDown={(e) => e.stopPropagation()}>
        <Command className="command-palette" label="Command palette" shouldFilter={mode === "all"}>
          <div className="command-palette-field">
            <Search size={18} className="command-palette-icon" />
            <Command.Input autoFocus value={query} onValueChange={setQuery} placeholder="Search" className="command-palette-input native-field" />
          </div>
          <Command.List className="command-palette-list">
            {search.reason ? (
              <HostedPaletteUnavailable label="Search messages" reason={search.reason} />
            ) : (
              <Command.Empty className="px-3 py-6 text-center text-base text-ink-3">{emptySearchMessage(query, mode === "messages", search.fetching)}</Command.Empty>
            )}
            {mode === "all" ? <PlaceGroups typed={typed} go={go} /> : null}
            {mode === "all" && typed ? <TeamChatPalette onOpened={() => onOpenChange(false)} /> : null}
            <MessageHits hits={search.hits} go={go} />
            <TeamChatSearchHits query={query} onOpened={() => onOpenChange(false)} />
            {mode === "all" && typed ? <ProjectGroup go={go} /> : null}
            {mode === "messages" ? null : (
              <Command.Group heading="Actions" className="command-palette-group">
                {paletteActions
                  .filter((action) => (action.available?.() ?? true) && !(organization?.organization && action.label === "Add project"))
                  .map(({ label, icon: Icon, run }) =>
                    search.newFileReason && label === "New file" ? (
                      <HostedPaletteUnavailable key={label} label={label} reason={search.newFileReason} />
                    ) : (
                      <Item key={label} onSelect={() => go(run)} icon={<Icon size={18} />} label={label} />
                    ),
                  )}
                <OrganizationPalette go={go} />
              </Command.Group>
            )}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}

type Place = { key: string; value: string; label: string; icon: ReactNode; place?: string; age?: string; open: () => void };

function PlaceGroup({ heading, places, go }: { heading: string; places: Place[]; go: (fn: () => void) => void }) {
  if (!places.length) return null;
  return (
    <Command.Group heading={heading} className="command-palette-group">
      {places.map((place) => (
        <Item key={place.key} value={place.value} onSelect={() => go(place.open)} icon={place.icon} label={place.label} place={place.place} age={place.age} />
      ))}
    </Command.Group>
  );
}

/** A thread's mark: what it needs or the working cube, else its agent's. */
function threadIcon(thread: ThreadSummary): ReactNode {
  const agent = isHarnessId(thread.agent) ? <HarnessLogo id={thread.agent} size={18} /> : <MessageSquare size={18} />;
  return <ThreadStatusIndicator thread={thread} idle={agent} />;
}

/**
 * Before a word is typed, the latest threads; then threads, Orclings and tasks by name, each with where it lives and its
 * age. An Orcling's own conversation is listed under its name, as the sidebar lists it.
 */
function PlaceGroups({ typed, go }: { typed: boolean; go: (fn: () => void) => void }) {
  const tasks = useRpc("tasks.list", {}).data ?? [];
  const threads = useRpc("threads.list", { limit: 40, excludeSubagents: true }).data ?? [];
  const projectName = useProjectNames();
  const orclings = useOrclings();
  const homes = useOrclingChatIds();
  const now = useSidebarNow();
  const listed = threads.filter((t) => !homes.has(t.id)).slice(0, typed ? undefined : RECENT);
  const threadPlaces = listed.map((t) => ({
    key: t.id,
    value: `thread ${t.title} ${t.id}`,
    label: t.title,
    icon: threadIcon(t),
    place: projectName(t.projectId),
    age: rowAge(latestActivity(t), now),
    open: () => openThread(t.id),
  }));
  if (!typed) return <PlaceGroup heading="Recent" go={go} places={threadPlaces} />;
  return (
    <>
      <PlaceGroup heading="Threads" go={go} places={threadPlaces} />
      <PlaceGroup
        heading="Orclings"
        go={go}
        places={orclings.map((o) => ({ key: o.id, value: `orcling ${o.name}`, label: o.name, icon: <Orclings size={18} />, open: () => openThread(o.threadId) }))}
      />
      <PlaceGroup
        heading="Tasks"
        go={go}
        places={tasks.map((t) => ({
          key: t.id,
          value: `task ${t.title} ${t.id}`,
          label: t.title,
          icon: <StatusIcon status={t.status} />,
          place: projectName(t.projectId),
          age: rowAge(t.updatedAt, now),
          open: () => openTask(t.id),
        }))}
      />
    </>
  );
}

/** Messages that match, each with its speaker's mark, where it was said and its age. */
function MessageHits({ hits, go }: { hits: RpcHits; go: (fn: () => void) => void }) {
  const now = useSidebarNow();
  if (!hits.length) return null;
  return (
    <Command.Group heading="Messages" className="command-palette-group">
      {hits.map((h) => (
        <Item
          key={`${h.runId}-${h.messageId}`}
          value={`message ${h.threadTitle} ${h.snippet} ${h.ts}`}
          onSelect={() => {
            const message = { runId: h.runId, turn: h.turn, messageId: h.messageId, ...(h.role === "note" ? { note: true as const } : {}) };
            go(() => (h.taskId ? openTask(h.taskId, "chat", message) : openThread(h.threadId, message)));
          }}
          icon={<MessageSquare size={18} />}
          label={h.snippet}
          place={h.member ? `${h.member.name} in ${h.taskTitle ?? h.threadTitle}` : (h.taskTitle ?? h.threadTitle)}
          age={rowAge(h.ts, now)}
        />
      ))}
    </Command.Group>
  );
}

type RpcHits = NonNullable<ReturnType<typeof useRpc<"threads.search">>["data"]>;

function ProjectGroup({ go }: { go: (fn: () => void) => void }) {
  const projects = useSpaceProjects(true).data ?? [];
  const navigate = useRouter((s) => s.navigate);
  return (
    <PlaceGroup
      heading="Projects"
      go={go}
      places={projects.map((p) => ({ key: p.id, value: `project ${p.name}`, label: p.name, icon: <ProjectLogo project={p} size={18} />, open: () => navigate({ view: "project", projectId: p.id }) }))}
    />
  );
}

/** A project's name by its id, for the faint place on a row. */
function useProjectNames(): (id: string) => string | undefined {
  const projects = useSpaceProjects().data ?? [];
  return (id) => projects.find((project) => project.id === id)?.name;
}

/** A row: its mark, its label, where it lives in faint ink, and its age at the end. */
function Item({ icon, label, place, age, onSelect, value }: { icon: ReactNode; label: string; place?: string | undefined; age?: string | undefined; onSelect: () => void; value?: string }) {
  return (
    <Command.Item value={value} onSelect={onSelect} className="command-palette-item">
      <span className="command-palette-icon">{icon}</span>
      <span className="command-palette-label">{label}</span>
      {place ? <span className="command-palette-place">{place}</span> : null}
      {age ? <span className="command-palette-age tabular">{age}</span> : null}
    </Command.Item>
  );
}
