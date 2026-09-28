import { useEffect, useRef, useState } from "react";
import { TeamDraft, type TeamDetail } from "@openorc/protocol";
import { removeDraft, writeDraft } from "./drafts";
import { queryClient, useRpcMutation } from "./query";
import { blankTeam, editorDraft, hasRevisionConflict, revisionDraft, type EditorDraft } from "./team-editor-draft";

/** Owns an unfinished local team draft and its server revision until it is saved or discarded. */
export function useTeamEditor(projectId: string, detail: TeamDetail | null, onSaved: (detail: TeamDetail) => void) {
  const key = `orchestration.${projectId}.${detail?.team.id ?? "new"}`;
  const [state, setState] = useState(() => editorDraft(key, detail));
  const [storageFailed, setStorageFailed] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [checkedDraft, setCheckedDraft] = useState<string | null>(null);
  const save = useRpcMutation("orchestration.save");
  const archive = useRpcMutation("orchestration.archive");
  const preflight = useRpcMutation("orchestration.preflight");
  const busyRef = useRef(false);
  const validationRef = useRef<HTMLDivElement>(null);
  const draft = state.draft;
  const signature = JSON.stringify(draft);
  const dirty = signature !== JSON.stringify(state.base);
  const conflict = hasRevisionConflict(state, detail, save.data);
  const archived = Boolean(detail?.team.archivedAt);
  const busy = save.isPending || archive.isPending;
  const parsed = TeamDraft.safeParse(draft);
  const problems = parsed.success ? [] : [...new Set(parsed.error.issues.map((issue) => issue.message))];
  const readiness = checkedDraft === signature ? preflight.data : undefined;
  const preflightError = checkedDraft === signature ? preflight.error : null;

  const persist = (next: EditorDraft) => {
    setState(next);
    setStorageFailed(!writeDraft(key, next));
  };
  const patch = (value: Partial<TeamDraft>) => {
    persist({ ...state, draft: { ...draft, ...value } });
    setDiscarding(false);
  };

  // A clean editor follows another window's revision; unfinished work stays local.
  useEffect(() => {
    if (!detail || !conflict || dirty || busy) return;
    const next = revisionDraft(detail);
    setState({ draft: next, base: next, expectedRevisionId: detail.revision.id });
    removeDraft(key);
  }, [detail, conflict, dirty, busy, key]);

  const submit = async (asNew = false) => {
    setAttempted(true);
    if (!parsed.success) {
      requestAnimationFrame(() => {
        validationRef.current?.scrollIntoView({ block: "nearest" });
        validationRef.current?.focus({ preventScroll: true });
      });
      return;
    }
    if (busyRef.current || (!asNew && (conflict || archived))) return;
    busyRef.current = true;
    try {
      const result = await save.mutateAsync({ projectId, ...(detail && !asNew ? { teamId: detail.team.id } : {}), expectedRevisionId: asNew ? null : state.expectedRevisionId, draft: parsed.data });
      const saved = revisionDraft(result);
      setState({ draft: saved, base: saved, expectedRevisionId: result.revision.id });
      setStorageFailed(false);
      removeDraft(key);
      onSaved(result);
    } catch {
      // A conflict may arrive before another window's invalidation push.
      if (detail) void queryClient.invalidateQueries({ queryKey: ["orchestration.get", { id: detail.team.id }] });
    } finally {
      busyRef.current = false;
    }
  };

  const toggleArchive = async () => {
    if (!detail || (!archived && dirty) || conflict || busyRef.current) return;
    busyRef.current = true;
    try {
      onSaved(await archive.mutateAsync({ projectId, teamId: detail.team.id, expectedRevisionId: detail.revision.id, archived: !archived }));
    } catch {
      /* The action error stays beside the save controls. */
    } finally {
      busyRef.current = false;
    }
  };

  const discard = () => {
    const next = detail ? revisionDraft(detail) : blankTeam();
    setState({ draft: next, base: next, expectedRevisionId: detail?.revision.id ?? null });
    removeDraft(key);
    setStorageFailed(false);
    setDiscarding(false);
    setAttempted(false);
    save.reset();
  };

  const checkReadiness = () => {
    setCheckedDraft(signature);
    preflight.mutate({ projectId, draft });
  };

  return {
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
    retryStorage: () => setStorageFailed(!writeDraft(key, state)),
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
  };
}
