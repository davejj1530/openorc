import { useMemo } from "react";
import { projectAccountChoice, type AccountsProject } from "@openorc/client";
import {
  commentMentionOptions,
  commentRecipientKey,
  executionModeAvailable,
  harnessLoggedIn,
  type ClaudeAccount,
  type CommentMentionOption,
  type ModelOption,
  type ThreadChoice,
} from "@openorc/protocol";
import { useRpc } from "./client";

type ThreadModel = Pick<ThreadChoice, "agent" | "model" | "effort">;

export const threadModelKey = (choice: ThreadModel): string => commentRecipientKey({ agent: choice.agent, model: choice.model, effort: choice.effort });

/** The agents signed in on this machine. Undefined until the check answers, so nothing is hidden before it does. */
function useSignedInAgents(): ReadonlySet<string> | undefined {
  const rows = useRpc("agents.availability", {}, { staleTime: 60000 }).data;
  return useMemo(() => (rows ? new Set(rows.filter(harnessLoggedIn).map((row) => row.id)) : undefined), [rows]);
}

const NO_OPTIONS: readonly CommentMentionOption[] = [];

/**
 * Every model and effort a task's thread can start with, from the agents signed in here, named as comments name them,
 * after any of `first`, such as Orclings, whose agent can run here too. A Plan run needs Plan.
 */
export function useThreadModels(plan: boolean, first = NO_OPTIONS): { models: ModelOption[] | undefined; options: CommentMentionOption[] } {
  const models = useRpc("agents.models", {}, { staleTime: 300000 }).data;
  const signedIn = useSignedInAgents();
  const options = useMemo(
    () =>
      [...first, ...commentMentionOptions((models ?? []).filter((model) => !model.unavailable))].filter(
        ({ recipient }) => (!signedIn || signedIn.has(recipient.agent)) && (!plan || executionModeAvailable(recipient.agent, "plan")),
      ),
    [first, models, plan, signedIn],
  );
  return { models, options };
}

/**
 * The Claude accounts a thread in the project can start on: the project's own while it keeps them, else the app's
 * enabled ones. One chosen before the project stopped using it stays listed, so the choice shows by name.
 */
export function useProjectClaudeAccounts(project: AccountsProject | null | undefined, chosen?: string, enabled = true): ClaudeAccount[] | undefined {
  const list = useRpc("claude.accounts.list", {}, { enabled }).data;
  if (!list) return undefined;
  const allowed = projectAccountChoice(project, list).accounts.filter((account) => account.enabled);
  return chosen && !allowed.some((account) => account.id === chosen) ? [...allowed, ...list.accounts.filter((account) => account.id === chosen)] : allowed;
}
