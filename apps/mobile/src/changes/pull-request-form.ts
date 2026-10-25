import { pullRequestHead, pullRequestTarget } from "@openorc/client";
import type { PullRequestBranches } from "@openorc/protocol";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { useRpc } from "../client";
import type { PullRequestDraft } from "./drafts";
import { changeDrafts } from "./publishing";
import type { ChangesReads } from "./use-changes";

/** A native menu lists this many branches at most; past it, a search sheet does. */
export const MENU_BRANCHES = 20;

/** The branch the pull request opens from, and the target it suggests until another is chosen. */
function targetOf(reads: ChangesReads, branches: PullRequestBranches | undefined) {
  const thread = reads.thread.data;
  const project = reads.project.data;
  const head = project ? pullRequestHead(reads.push.data, project) : null;
  return { head, suggested: pullRequestTarget({ started: thread?.baseBranch ?? null, projectDefault: project?.defaultBranch ?? null, head, branches }) };
}

/** The newest commit's subject, else the thread's title. */
const defaultTitle = (reads: ChangesReads): string => reads.log.data?.[0]?.subject ?? reads.thread.data?.title ?? "";

/**
 * A new pull request's target, title and body. Each follows its default until the reader edits it (where the work
 * started, the newest commit's subject or the thread's title, the repository's template), and edits are kept.
 */
export function usePullRequestForm(threadId: string, reads: ChangesReads) {
  const thread = reads.thread.data ?? null;
  const project = reads.project.data ?? null;
  const [draft, setDraft] = useState<PullRequestDraft>(() => changeDrafts.pullRequest(threadId));
  // The branch search sheet keeps its pick in the draft.
  useFocusEffect(useCallback(() => setDraft(changeDrafts.pullRequest(threadId)), [threadId]));
  const template = useRpc("review.threadPrTemplate", { threadId });
  const prefer = thread?.baseBranch ?? project?.defaultBranch ?? undefined;
  const branches = useRpc("pulls.branches", { projectId: project?.id ?? "", ...(prefer ? { prefer } : {}) }, { enabled: Boolean(project) });
  const { head, suggested } = targetOf(reads, branches.data);
  const edit = (change: PullRequestDraft) => {
    changeDrafts.editPullRequest(threadId, change);
    setDraft((current) => ({ ...current, ...change }));
  };
  return {
    head,
    title: draft.title ?? defaultTitle(reads),
    body: draft.body ?? template.data?.body ?? "",
    base: draft.base ?? suggested,
    /** Every branch a pull request can target: GitHub's, never the one it opens from. */
    options: (branches.data?.branches ?? (suggested ? [suggested] : [])).filter((branch) => branch !== head),
    branches,
    edit,
  };
}
