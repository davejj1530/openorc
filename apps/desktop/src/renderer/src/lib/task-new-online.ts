import { useRef, useState } from "react";
import { onlineTaskRpcParams, type OnlineTaskAssignee, type OnlineTaskRef, type TaskPriority } from "@openorc/protocol";
import type { DocumentEditorHandle } from "../components/DocumentEditor";
import { useTaskProjects } from "./task-list-source";
import { useTaskOnlineMutation, type TaskOnlineScope } from "./task-online-query";
import { TaskCreateDraft } from "./task-create-draft";
import { readDraft, removeDraft, writeDraft } from "./drafts";
import { openOnlineTask } from "./task-open";
import { taskRefKey } from "./task-ref";
import { validateOnlineTaskSpec } from "./task-online-spec";
import { useRouter } from "./router";
import { useSpaceNavigation, spaceNavigation } from "./space-navigation";

type Draft = { title: string; spec: string; projectId: string; priority: TaskPriority };
export function useNewOnlineTask(scope: TaskOnlineScope, projectId?: string, threadId?: string) {
  const projects = useTaskProjects(scope);
  const mutation = useTaskOnlineMutation("tasks.online.create");
  const write = useRef(mutation.mutateAsync);
  write.current = mutation.mutateAsync;
  const [creator] = useState(() => new TaskCreateDraft((input) => write.current(input)));
  const key = `newtask.online.${JSON.stringify([scope.accountId, scope.spaceId, projectId ?? "all", threadId ?? "none"])}`;
  const [draft, setDraft] = useState(() => readDraft<Draft>(key, { title: "", spec: "", projectId: "", priority: "none" }));
  const current = useRef(draft);
  current.current = draft;
  const [stored, setStored] = useState(true);
  const [assignee, setAssignee] = useState<OnlineTaskAssignee | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imagesReady, setImagesReady] = useState(true);
  const body = useRef<DocumentEditorHandle>(null);
  const submitting = useRef(false);
  const eligible = (projects.data ?? []).filter((project) => project.hostedProjectId);
  const selected = eligible.find((project) => project.hostedProjectId === draft.projectId) ?? eligible.find((project) => project.key === projectId) ?? eligible[0];
  const source = useSpaceNavigation((state) =>
    state.inventory.find((space) => space.id === scope.spaceId)?.threads.find((thread) => thread.id === threadId && thread.owner?.brain === "hosted" && thread.projectId === selected?.key),
  );
  const patch = (change: Partial<Draft>) => {
    const next = { ...current.current, ...change };
    current.current = next;
    setDraft(next);
    setStored(writeDraft(key, next));
  };
  const submit = async () => {
    if (!selected?.hostedProjectId || !current.current.title.trim() || submitting.current) return;
    submitting.current = true;
    setError(null);
    const route = useRouter.getState().route;
    const navigation = spaceNavigation.getState();
    try {
      if (body.current && !(await body.current.flush())) return;
      const words = current.current;
      validateOnlineTaskSpec(words.spec);
      const input = onlineTaskRpcParams["tasks.online.create"].parse({
        spaceId: scope.spaceId,
        projectId: selected.hostedProjectId,
        requestId: crypto.randomUUID(),
        title: words.title.trim(),
        spec: words.spec.trim(),
        priority: words.priority,
        assigneeMemberId: assignee?.memberId ?? null,
        ...(threadId && { source: source ? { kind: "thread", threadId: source.id } : { kind: "private" } }),
      });
      const result = await creator.save(input);
      const reference: OnlineTaskRef = { kind: "online", accountId: scope.accountId, spaceId: scope.spaceId, projectId: result.task.projectId, id: result.task.id };
      const latest = current.current;
      if (latest.title.trim() !== result.task.title || latest.spec.trim() !== (result.task.spec ?? ""))
        writeDraft(`task.${taskRefKey(reference)}`, { title: latest.title, spec: latest.spec, labels: result.task.labels.join(", ") });
      removeDraft(key);
      if (sameDestination(route, navigation)) openOnlineTask(reference);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      submitting.current = false;
    }
  };
  return { projects, eligible, selected, draft, patch, stored, assignee, setAssignee, error, imagesReady, setImagesReady, body, submit, pending: mutation.isPending, locked: creator.pending, source };
}

function sameDestination(route: ReturnType<typeof useRouter.getState>["route"], navigation: Pick<ReturnType<typeof spaceNavigation.getState>, "current" | "key">): boolean {
  const now = spaceNavigation.getState();
  return useRouter.getState().route === route && now.current === navigation.current && now.key === navigation.key;
}
