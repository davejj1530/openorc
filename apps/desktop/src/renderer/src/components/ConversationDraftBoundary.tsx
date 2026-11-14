import type { HostedFileScope, ThreadSummary } from "@openorc/protocol";
import type { ReactNode } from "react";
import { useHostedFileContext } from "../lib/hosted-file-scope";
import { hostedConversationDraftKey } from "../lib/task-thread-storage";
import { Empty, TextButton } from "./ui";

/** A shared conversation's unsent work belongs to this account and space, including before its project read finishes. */
export function ConversationDraftBoundary({ thread, children }: { thread: ThreadSummary; children(input: { draftKey: string; scope: HostedFileScope | null }): ReactNode }) {
  const context = useHostedFileContext({ projectId: thread.projectId, threadId: thread.id, enabled: true });
  if (context.identity) return children({ draftKey: hostedConversationDraftKey(context.identity, thread.id), scope: context.scope });
  if (!context.error) return null;
  return <Empty title={context.error.message} action={<TextButton onClick={context.retry}>Try again</TextButton>} />;
}
