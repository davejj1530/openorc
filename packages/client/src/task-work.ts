import {
  commentMentionOptions,
  commentRecipientKey,
  executionModeAvailable,
  type AgentKind,
  type CommentMentionOption,
  type ModelOption,
  type TaskButton,
  type TaskStatus,
  type TaskThreadLink,
} from "@openorc/protocol";
import { defaultChoice } from "./model-picker-selection.js";

/** Whether a task's button shows on a task in `status`. Archived tasks show no buttons, since none can run there. */
export const showsOn = (button: Pick<TaskButton, "statuses">, status: TaskStatus): boolean => status !== "archived" && (!button.statuses || button.statuses.includes(status));

/** What a button reads while its press is on its way: one set not to send only opens its thread. */
export const buttonPendingLabel = (button: Pick<TaskButton, "autoSend">): string => (button.autoSend === false ? "Opening…" : "Starting…");

/** A task's thread by its part in the task. A working thread has no label: the current one, else earlier work. A button's thread goes by the button's label. */
export function taskThreadRole(link: Pick<TaskThreadLink, "current" | "label">): string {
  if (link.current) return "Current thread";
  return link.label ?? "Earlier thread";
}

/**
 * Every model and effort a task's thread can start with, from the agents signed in on the Mac, named as comments name
 * them, after any of `first`, such as Orclings, whose agent can run there too. `signedIn` is undefined until the check
 * answers, so nothing is hidden before it does. A Plan run needs Plan.
 */
export function threadModelOptions(models: ModelOption[] | undefined, signedIn: ReadonlySet<string> | undefined, plan: boolean, first: readonly CommentMentionOption[] = []): CommentMentionOption[] {
  return [...first, ...commentMentionOptions((models ?? []).filter((model) => !model.unavailable))].filter(
    ({ recipient }) => (!signedIn || signedIn.has(recipient.agent)) && (!plan || executionModeAvailable(recipient.agent, "plan")),
  );
}

/** Who refines a task when nothing is picked: the last choice, else the default model a new thread offers, from those listed, else the first listed. */
export function refineChoice(options: readonly CommentMentionOption[], models: ModelOption[] | undefined, defaultAgent: AgentKind | null, last: string | null): string {
  const keys = options.map((option) => commentRecipientKey(option.recipient));
  if (last && keys.includes(last)) return last;
  const own = options.filter((option) => !option.recipient.orclingId);
  const listed = (model: ModelOption) => own.some(({ recipient }) => recipient.agent === model.agent && recipient.model === model.id);
  const preferred = defaultChoice((models ?? []).filter(listed), defaultAgent);
  const atModel = own.filter(({ recipient }) => recipient.agent === preferred?.agent && recipient.model === preferred.model);
  const option = atModel.find(({ recipient }) => recipient.effort === preferred?.effort) ?? atModel[0];
  return option ? commentRecipientKey(option.recipient) : (keys[0] ?? "");
}
