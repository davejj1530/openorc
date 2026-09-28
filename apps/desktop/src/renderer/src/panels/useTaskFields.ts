import { useEffect, useState } from "react";
import type { Task, TaskPriority, TaskStatus } from "@openorc/protocol";
import { useRpcMutation } from "../lib/query";

type FieldDraft = { spec: string; labels: string; receivedSpec: string; receivedLabels: string };

function taskFields(task: Task): { spec: string; labels: string } {
  return { spec: task.spec ?? "", labels: task.labels.join(", ") };
}

/** Local text edits survive failed saves; pristine fields follow newer task data. */
export function useTaskFields(task: Task) {
  const update = useRpcMutation("tasks.update");
  const received = taskFields(task);
  const [draft, setDraft] = useState<FieldDraft>(() => ({ ...received, receivedSpec: received.spec, receivedLabels: received.labels }));

  useEffect(() => {
    setDraft((current) => {
      if (current.receivedSpec === received.spec && current.receivedLabels === received.labels) return current;
      return {
        spec: current.spec === current.receivedSpec ? received.spec : current.spec,
        labels: current.labels === current.receivedLabels ? received.labels : current.labels,
        receivedSpec: received.spec,
        receivedLabels: received.labels,
      };
    });
  }, [received.spec, received.labels]);

  const dirty = draft.spec !== received.spec || draft.labels !== received.labels;
  const save = () => {
    update.mutate({
      id: task.id,
      patch: {
        spec: draft.spec.trim() || null,
        labels: draft.labels
          .split(",")
          .map((label) => label.trim())
          .filter(Boolean),
      },
    });
  };

  return {
    spec: draft.spec,
    labels: draft.labels,
    dirty,
    isPending: update.isPending,
    error: update.error,
    setSpec: (spec: string) => setDraft((current) => ({ ...current, spec })),
    setLabels: (labels: string) => setDraft((current) => ({ ...current, labels })),
    discard: () => setDraft({ ...received, receivedSpec: received.spec, receivedLabels: received.labels }),
    save,
    changeStatus: (status: TaskStatus) => update.mutate({ id: task.id, patch: { status } }),
    changePriority: (priority: TaskPriority) => update.mutate({ id: task.id, patch: { priority } }),
  };
}
