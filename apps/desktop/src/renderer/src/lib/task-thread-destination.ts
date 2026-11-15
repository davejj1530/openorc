import type { HostedFileScope, ThreadSummary } from "@openorc/protocol";
import { hostedDraftFiles } from "./hosted-attachment-runtime";
import { hostedConversationDraftKey } from "./task-thread-storage";
import { core } from "./rpc";
import { spaceNavigation } from "./space-navigation";
import { openThread, useRouter } from "./router";

export function taskThreadDestination(scope: HostedFileScope) {
  const navigation = spaceNavigation.getState();
  const route = useRouter.getState().route;
  let thread: ThreadSummary | null = null;
  return {
    async files(captured: HostedFileScope, threadId: string) {
      const [files, found] = await Promise.all([
        hostedDraftFiles({ scope: captured, draftKey: `${hostedConversationDraftKey(captured, threadId)}.attachments` }),
        core.call("threads.get", { id: threadId }),
      ]);
      if (!found || found.owner?.brain !== "hosted") throw new Error("This task’s thread is unavailable.");
      thread = found;
      return files.length;
    },
    navigate(threadId: string) {
      const current = spaceNavigation.getState();
      if (!thread || current.key !== navigation.key || current.current !== navigation.current || current.generation !== navigation.generation) return;
      current.observe(scope.spaceId, [thread], navigation.key);
      if (useRouter.getState().route === route) openThread(threadId);
    },
  };
}
