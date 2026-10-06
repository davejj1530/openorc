import { useEffect, useState, type ReactNode } from "react";
import { TEAM_LIMIT_BOUNDS, type TeamDetail } from "@openorc/protocol";
import { Archive, ArchiveRestore, Check, Plus } from "../components/icons";
import { TopBar } from "../components/TopBar";
import { Badge, Button, Empty, IconButton, Input, Select, Switch, TextButton, Tooltip } from "../components/ui";
import { useLayout } from "../lib/layout";
import { queryClient, useRpc } from "../lib/query";
import { newThread, useRouter } from "../lib/router";
import { useTeamEditor } from "../lib/use-team-editor";
import { useUi } from "../lib/ui";
import { TeamMembers } from "./TeamMemberControls";
import "./Orchestration.css";

function teamSelectorLabel(loading: boolean, unavailable: boolean): string {
  if (loading) return "Loading teams…";
  if (unavailable) return "Teams unavailable";
  return "New team";
}

function projectGate(input: { loading: boolean; error: Error | null; selected: boolean; requestedProject: boolean; retry: () => void; importProject: () => void }): ReactNode {
  if (input.loading)
    return (
      <div className="p-6 text-sm text-ink-3" role="status">
        Loading projects…
      </div>
    );
  if (input.error && !input.selected)
    return (
      <Empty title="Projects couldn’t load">
        <Button onClick={input.retry}>Try again</Button>
      </Empty>
    );
  if (!input.selected)
    return (
      <Empty title={input.requestedProject ? "Project not found" : "Import a project to create a team"}>
        <Button onClick={input.importProject}>Import project</Button>
      </Empty>
    );
  return null;
}

function teamAvailabilityStatus(input: { error: boolean; available: boolean; enabled: boolean; maxHierarchyDepth?: number; retry: () => void; openSettings: () => void }): ReactNode {
  if (input.error)
    return (
      <>
        <Badge className="mr-2">Status unavailable</Badge> Design and save teams. Team execution availability could not be checked.{" "}
        <TextButton type="button" underline onClick={input.retry}>
          Retry
        </TextButton>
      </>
    );
  if (input.available && input.enabled)
    return (
      <>
        <Badge tone="ok" className="mr-2">
          Team execution on · Beta
        </Badge>
        Choose a saved team in a new task’s model selector. Teams can include a lead, managers and workers (up to {input.maxHierarchyDepth} levels).
      </>
    );
  if (input.available)
    return (
      <>
        <Badge tone="warn" className="mr-2">
          Team execution off
        </Badge>
        You can design and save teams. Enable Team execution (Beta) in{" "}
        <TextButton type="button" underline onClick={input.openSettings}>
          Settings
        </TextButton>{" "}
        to run them.
      </>
    );
  return (
    <>
      <Badge className="mr-2">Checking…</Badge> You can design and save teams. Checking team execution availability…
    </>
  );
}

function teamSaveStatus(input: { storageFailed: boolean; saving: boolean; dirty: boolean; existing: boolean; retryStorage: () => void }): ReactNode {
  if (input.storageFailed)
    return (
      <p className="text-bad">
        Couldn’t keep this draft on your device. Keep this page open.{" "}
        <TextButton type="button" underline onClick={input.retryStorage}>
          Retry
        </TextButton>
      </p>
    );
  if (input.saving) return "Saving team…";
  if (input.dirty) return "Unsaved changes · draft kept on this device";
  if (input.existing) return "Saved. Editing creates a new version.";
  return "Save a team to keep this configuration.";
}

function teamDiscardAction(input: { discarding: boolean; dirty: boolean; conflict: boolean; busy: boolean; discard: () => void; setDiscarding: (value: boolean) => void }): ReactNode {
  if (input.discarding)
    return (
      <span className="flex items-center gap-2 mt-1">
        Discard your unsaved edits?{" "}
        <TextButton type="button" disabled={input.busy} underline className="text-bad" onClick={input.discard}>
          Discard draft
        </TextButton>
        <TextButton type="button" disabled={input.busy} underline onClick={() => input.setDiscarding(false)}>
          Keep editing
        </TextButton>
      </span>
    );
  if (input.dirty || input.conflict)
    return (
      <TextButton type="button" disabled={input.busy} underline className="block mt-1" onClick={() => input.setDiscarding(true)}>
        Discard draft{input.conflict ? " and load saved version" : ""}
      </TextButton>
    );
  return null;
}

export function Orchestration({ projectId, teamId }: { projectId?: string; teamId?: string }) {
  const projects = useRpc("projects.list", {});
  const railProject = useLayout((s) => s.projectId);
  const navigate = useRouter((s) => s.navigate);
  const selected = projects.data?.find((p) => p.id === (projectId ?? railProject)) ?? (!projectId ? projects.data?.[0] : undefined);
  const gate = projectGate({
    loading: projects.isLoading,
    error: projects.error,
    selected: Boolean(selected),
    requestedProject: Boolean(projectId),
    retry: () => void projects.refetch(),
    importProject: () => useUi.getState().setImportProject(true),
  });
  return (
    <div className="orchestration workspace-main h-full min-h-0 flex flex-col">
      <TopBar
        projectId={selected?.id}
        projectName={selected?.name}
        onProjectChange={(id) => {
          if (id && projects.data?.some((p) => p.id === id)) navigate({ view: "orchestration", projectId: id });
          else newThread(id ?? undefined);
        }}
      >
        Orchestration
      </TopBar>
      {projects.error && selected ? (
        <div role="alert" className="px-6 py-3 text-sm text-ink-3">
          Projects couldn’t refresh. Your current editor is still available.{" "}
          <TextButton underline disabled={projects.isFetching} onClick={() => void projects.refetch()}>
            Retry
          </TextButton>
        </div>
      ) : null}
      {gate ??
        (selected ? (
          <ProjectTeams
            key={selected.id}
            projectId={selected.id}
            teamId={teamId}
            projectPicker={
              <label className="orchestration-switcher">
                Project
                <Select
                  aria-label="Orchestration project"
                  value={selected.id}
                  onChange={(event) => {
                    useLayout.getState().setProject(event.target.value);
                    navigate({ view: "orchestration", projectId: event.target.value });
                  }}
                >
                  {projects.data?.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </Select>
              </label>
            }
          />
        ) : null)}
    </div>
  );
}

function ProjectTeams({ projectId, teamId, projectPicker }: { projectId: string; teamId?: string; projectPicker: ReactNode }) {
  const list = useRpc("orchestration.list", { projectId, includeArchived: true });
  const availability = useRpc("orchestration.availability", {});
  const [showArchived, setShowArchived] = useState(false);
  const [initialTeamId, setInitialTeamId] = useState<string | null>(null);
  const navigate = useRouter((s) => s.navigate);
  const selectedId = teamId ?? initialTeamId ?? list.data?.find((item) => !item.team.archivedAt)?.team.id ?? "new";
  // A refresh can reorder teams or archive one in another window. Keep the
  // editor the user opened until they explicitly choose a different team.
  useEffect(() => {
    if (!teamId && initialTeamId === null && list.data) setInitialTeamId(selectedId);
  }, [teamId, initialTeamId, list.data, selectedId]);
  const detail = useRpc("orchestration.get", { id: selectedId }, { enabled: selectedId !== "new" });
  const select = (id: string) => navigate({ view: "orchestration", projectId, teamId: id });
  const saved = (item: TeamDetail) => {
    queryClient.setQueryData(["orchestration.get", { id: item.team.id }], item);
    const route = useRouter.getState().route;
    const stillEditing = route.view === "orchestration" && (route.projectId ?? useLayout.getState().projectId ?? projectId) === projectId && (route.teamId ?? selectedId) === selectedId;
    // Pin an implicit selection too: archiving must not make the editor jump
    // to another team when the active list refreshes.
    if (stillEditing && route.view === "orchestration" && route.teamId !== item.team.id) select(item.team.id);
  };
  const teams = list.data?.filter((item) => showArchived || !item.team.archivedAt || item.team.id === selectedId) ?? [];
  const initialListError = !list.data && !teamId ? list.error : null;
  let editor: ReactNode;
  if (initialListError) editor = <TeamLoadError error={initialListError} onRetry={() => void list.refetch()} retrying={list.isFetching} />;
  else if (selectedId === "new")
    editor =
      list.isLoading && teamId !== "new" ? (
        <div className="p-6 text-sm text-ink-3" role="status">
          Loading teams…
        </div>
      ) : (
        <TeamEditor key="new" projectId={projectId} detail={null} onSaved={saved} />
      );
  else if (detail.data && detail.data.team.projectId === projectId) editor = <TeamEditor key={detail.data.team.id} projectId={projectId} detail={detail.data} onSaved={saved} />;
  else if (detail.isLoading)
    editor = (
      <div className="p-6 text-sm text-ink-3" role="status">
        Loading team…
      </div>
    );
  else if (detail.error) editor = <TeamLoadError error={detail.error} title="Team couldn’t load" onRetry={() => void detail.refetch()} retrying={detail.isFetching} />;
  else
    editor = (
      <Empty title="Team not found">
        <Button onClick={() => select("new")}>Create a team</Button>
      </Empty>
    );
  return (
    <div className="orchestration-layout">
      <div className="orchestration-toolbar">
        <div className="orchestration-controls">
          {projectPicker}
          <label className="orchestration-switcher orchestration-team-switcher">
            Team
            <Select aria-label="Orchestration team" value={selectedId} disabled={!list.data} onChange={(event) => select(event.target.value)}>
              {selectedId === "new" ? <option value="new">{teamSelectorLabel(list.isLoading, Boolean(list.error && !list.data))}</option> : null}
              {selectedId !== "new" && !teams.some((item) => item.team.id === selectedId) ? (
                <option value={selectedId}>{detail.data?.revision.name ?? (detail.isLoading ? "Loading team…" : "Team unavailable")}</option>
              ) : null}
              {teams.map((item) => (
                <option key={item.team.id} value={item.team.id}>
                  {item.revision.name}
                  {item.team.archivedAt ? " · Archived" : ""}
                </option>
              ))}
            </Select>
          </label>
          <Tooltip label="New team">
            <IconButton aria-label="New team" disabled={!list.data} onClick={() => select("new")}>
              <Plus size={16} />
            </IconButton>
          </Tooltip>
          <label className="orchestration-archive-filter">
            <Switch checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
            Show archived
          </label>
        </div>
        <p className="orchestration-availability" role="status">
          {teamAvailabilityStatus({
            error: availability.isError,
            available: Boolean(availability.data),
            enabled: Boolean(availability.data?.enabled),
            maxHierarchyDepth: availability.data?.maxHierarchyDepth,
            retry: () => void availability.refetch(),
            openSettings: () => navigate({ view: "settings", section: "general", setting: "team-execution" }),
          })}
        </p>
      </div>
      {list.error && !initialListError ? <TeamLoadError error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} /> : null}
      <div className="orchestration-editor-region">{editor}</div>
    </div>
  );
}

function TeamLoadError({ error, title = "Teams couldn’t load", onRetry, retrying }: { error: Error; title?: string; onRetry: () => void; retrying: boolean }) {
  const outdatedCore = /unknown method.*orchestration\./i.test(error.message);
  return (
    <div className="orchestration-load-error" role="alert">
      <h2 className="text-base font-medium">{title}</h2>
      <p className="mt-1 text-sm text-ink-3">
        {outdatedCore ? "Restart OpenOrc to load the updated team editor, then try again." : "Try again to load your saved teams. Drafts kept on this device are preserved."}
      </p>
      <details className="mt-2 text-sm text-ink-3">
        <summary>Error details</summary>
        <p className="mt-1 break-words">{error.message}</p>
      </details>
      <Button className="mt-3" disabled={retrying} onClick={onRetry}>
        {retrying ? "Retrying…" : "Retry"}
      </Button>
    </div>
  );
}

function TeamEditor({ projectId, detail, onSaved }: { projectId: string; detail: TeamDetail | null; onSaved: (detail: TeamDetail) => void }) {
  const editor = useTeamEditor(projectId, detail, onSaved);
  const {
    draft,
    dirty,
    conflict,
    archived,
    busy,
    parsed,
    problems,
    attempted,
    discarding,
    setDiscarding,
    storageFailed,
    retryStorage,
    validationRef,
    save,
    archive,
    preflight,
    readiness,
    preflightError,
    patch,
    submit,
    toggleArchive,
    discard,
    checkReadiness,
  } = editor;
  return (
    <form
      className="orchestration-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          void submit();
        }
      }}
    >
      <div className="orchestration-editor-scroll">
        <div className="flex items-start justify-between gap-3 mb-6">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold">{detail ? "Edit team" : "Create a team"}</h1>
            <p className="mt-1 text-sm text-ink-3">Choose a lead, then define who reports to whom.</p>
          </div>
          {detail ? <Badge>{archived ? "Archived" : `Version ${detail.revision.number}`}</Badge> : null}
        </div>
        {conflict ? (
          <div role="alert" data-tone="warn" className="orchestration-notice text-warn">
            A newer version was saved in another window. Your draft is kept. Save it as a separate team, or discard it to load the saved version.
            <div className="mt-2">
              <Button size="sm" disabled={!parsed.success || busy} onClick={() => void submit(true)}>
                Save draft as new team
              </Button>
            </div>
          </div>
        ) : null}
        {archived ? <div className="orchestration-notice text-ink-3">This team is archived. Unarchive it to edit its configuration.</div> : null}
        <fieldset disabled={busy || archived} className="min-w-0 border-0 p-0 m-0">
          <label className="orchestration-card grid gap-1.5 text-sm text-ink-3 mb-6">
            Team name
            <Input aria-label="Team name" autoComplete="off" maxLength={120} placeholder="e.g. Delivery team" value={draft.name} onChange={(event) => patch({ name: event.target.value })} />
          </label>
          <TeamMembers draft={draft} teamId={detail?.team.id ?? null} onChange={patch} />
          <details className="orchestration-card mt-6">
            <summary className="text-base font-medium py-2">Execution limits</summary>
            <p className="text-sm text-ink-3 mb-3">These limits apply each time this saved team runs.</p>
            <div className="orchestration-fields">
              {(
                [
                  ["maxConcurrentAgents", "Concurrent agents"],
                  ["maxAssignments", "Assignments per execution"],
                  ["maxExecutionMinutes", "Execution time (minutes)"],
                  ["maxAttemptsPerAssignment", "Attempts per assignment"],
                ] as const
              ).map(([field, label]) => (
                <label key={field} className="grid gap-1.5 text-sm text-ink-3">
                  {label}
                  <Input
                    type="number"
                    min={TEAM_LIMIT_BOUNDS[field].min}
                    max={TEAM_LIMIT_BOUNDS[field].max}
                    step={1}
                    value={Number.isNaN(draft.limits[field]) ? "" : draft.limits[field]}
                    onChange={(event) => patch({ limits: { ...draft.limits, [field]: event.target.value === "" ? 0 : Number(event.target.value) } })}
                  />
                </label>
              ))}
            </div>
          </details>
        </fieldset>
        {attempted && problems.length > 0 ? (
          <div ref={validationRef} tabIndex={-1} role="alert" data-tone="bad" className="orchestration-notice text-bad">
            <p className="font-medium mb-1">Check the team configuration</p>
            <ul className="list-disc pl-4">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="mt-6 flex items-center gap-3 flex-wrap">
          <Button
            size="sm"
            disabled={!parsed.success || preflight.isPending || busy}
            onClick={() => {
              checkReadiness();
            }}
          >
            {preflight.isPending ? "Checking…" : "Check readiness"}
          </Button>
          {readiness?.ready ? (
            <span role="status" className="text-sm text-ok inline-flex items-center gap-1">
              <Check size={13} />
              Local checks passed
            </span>
          ) : null}
        </div>
        {readiness?.ready ? <p className="mt-2 text-sm text-ink-3">Account access is checked again when the team starts.</p> : null}
        {readiness && readiness.issues.length > 0 ? (
          <ul className="mt-3 grid gap-1 text-sm text-warn" role="status">
            {readiness.issues.map((issue, index) => (
              <li key={`${issue.memberKey}:${issue.code}:${index}`}>
                {issue.memberKey ? `${draft.members.find((member) => member.key === issue.memberKey)?.name ?? "Member"}: ` : ""}
                {issue.message}
              </li>
            ))}
          </ul>
        ) : null}
        {preflightError ? (
          <p role="alert" className="mt-3 text-sm text-bad">
            {preflightError.message}
          </p>
        ) : null}
      </div>
      <footer className="orchestration-footer">
        <div className="orchestration-footer-content">
          <div className="min-w-0 flex-1 text-sm text-ink-3" role="status">
            {save.error || archive.error ? (
              <p role="alert" className="text-bad break-words">
                {(save.error ?? archive.error)?.message}
              </p>
            ) : null}
            {teamSaveStatus({ storageFailed, saving: save.isPending, dirty, existing: Boolean(detail), retryStorage })}
            {teamDiscardAction({ discarding, dirty, conflict, busy, discard, setDiscarding })}
          </div>
          {detail ? (
            <Button
              variant="ghost"
              disabled={busy || (!archived && dirty) || conflict}
              title={dirty && !archived ? "Save or discard edits before archiving" : undefined}
              onClick={() => void toggleArchive()}
            >
              {archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
              {archived ? "Unarchive" : "Archive"}
            </Button>
          ) : null}
          <Button type="submit" disabled={busy || archived || conflict || (Boolean(detail) && !dirty)}>
            {save.isPending ? "Saving…" : "Save team"}
          </Button>
        </div>
      </footer>
    </form>
  );
}
