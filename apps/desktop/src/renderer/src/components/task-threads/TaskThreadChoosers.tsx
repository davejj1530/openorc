import type { HarnessId, Project, Run, Task, ThreadChoice, ThreadSummary } from "@openorc/protocol";
import { useKeptTaskAccount } from "../../lib/accounts-separate";
import { useRpc, useRpcMutation } from "../../lib/client";
import { useDefaultAgent } from "../../lib/default-harness";
import { openThread } from "../../lib/router";
import { ChevronDown, Plus } from "../icons";
import { IconButton, TextButton } from "../ui";
import { ThreadChoiceSheet, type InheritedSettings } from "./ThreadChoiceSheet";

const CHOOSE_MODEL = "Choose model for the new thread";
type BeforeOpen = () => Promise<boolean>;
/** The task page's one `tasks.openThread`, so Open thread waits while this sheet opens the thread too. */
type OpenTaskThread = ReturnType<typeof useRpcMutation<"tasks.openThread">>["mutateAsync"];

/** A failure throws, so the sheet says why. */
async function saveThenOpen(beforeOpen: BeforeOpen, thread: () => Promise<{ id: string }>): Promise<void> {
  if (!(await beforeOpen())) return;
  openThread((await thread()).id);
}

const withChoice = (choice: ThreadChoice | undefined) => (choice ? { choice } : {});

/**
 * What Open thread gives a task's first thread, as the core picks it: its last run's settings, else its creator thread's,
 * else the person's default agent's. Undefined while that agent is still unknown.
 */
function openedSettings(last: Run | undefined, creator: ThreadSummary | null | undefined, defaultAgent: HarnessId | undefined): InheritedSettings | undefined {
  const agent = last?.agent ?? creator?.agent ?? defaultAgent;
  if (!agent) return undefined;
  return {
    agent,
    model: last?.model ?? creator?.model ?? null,
    effort: last?.effort ?? creator?.effort ?? null,
    claudeAccountId: last?.claudeAccountId ?? creator?.claudeAccountId ?? null,
  };
}

/** Beside Open thread until the task has a thread: opens its first one on the model and account chosen. */
export function OpenThreadChooser({ task, project, runs, beforeOpen, open }: { task: Task; project: Project; runs: readonly Run[]; beforeOpen: BeforeOpen; open: OpenTaskThread }) {
  const creator = useRpc("threads.get", { id: task.threadId ?? "" }, { enabled: Boolean(task.threadId) && !task.executionThreadId }).data;
  const defaultAgent = useDefaultAgent();
  const keptAccount = useKeptTaskAccount(task);
  if (task.executionThreadId) return null;
  return (
    <ThreadChoiceSheet
      title="Open thread"
      confirm="Open thread"
      inherited={openedSettings(runs.at(-1), creator, defaultAgent)}
      project={project}
      keptAccount={keptAccount}
      side="top"
      align="end"
      trigger={
        <IconButton aria-label={CHOOSE_MODEL} data-tip={CHOOSE_MODEL}>
          <ChevronDown size={15} />
        </IconButton>
      }
      onConfirm={(choice) => saveThenOpen(beforeOpen, () => open({ taskId: task.id, ...withChoice(choice) }))}
    />
  );
}

/** Continue in a new thread: the fresh thread takes the current one's model and account unless others are chosen. */
export function ContinueThreadChooser({ task, thread, project, beforeOpen }: { task: Task; thread: ThreadSummary; project: Project; beforeOpen: BeforeOpen }) {
  const fresh = useRpcMutation("tasks.newThread");
  const keptAccount = useKeptTaskAccount(task);
  return (
    <ThreadChoiceSheet
      title="Continue in a new thread"
      confirm="Continue"
      inherited={thread}
      project={project}
      keptAccount={keptAccount}
      side="bottom"
      align="start"
      trigger={
        <TextButton tone="muted" className="flex items-center gap-2 mt-4 text-sm">
          <Plus size={13} /> Continue in a new thread
        </TextButton>
      }
      onConfirm={(choice) => saveThenOpen(beforeOpen, () => fresh.mutateAsync({ taskId: task.id, ...withChoice(choice) }))}
    />
  );
}
