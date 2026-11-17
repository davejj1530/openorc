import { newThreadStartInput, targetModel, type NewThreadDraft } from "@openorc/client";
import type { RpcParams } from "@openorc/protocol";
import { useRpcMutation } from "./client";

/**
 * The New thread composer's `onReady` for a start on OpenOrc Cloud: once the person begins writing the first message,
 * the machine the thread will run on is made ready, so Start finds it awake with the project's folder there. Focus
 * alone asks nothing, and neither does a start held back by a reason the composer shows.
 */
export function useCloudStartReady(input: {
  draft: NewThreadDraft;
  onCloud: boolean;
  held: boolean;
  permissionMode: RpcParams<"threads.start">["permissionMode"];
  spaceId: string | null | undefined;
}) {
  const ready = useRpcMutation("threads.readyStart");
  return (why?: "focus" | "words") => {
    if (why !== "words" || !input.onCloud || input.held || input.draft.target.kind !== "model" || !targetModel(input.draft.target)) return;
    const { projectId, agent, model, effort, mode, permissionMode } = newThreadStartInput(input.draft, { workspaceMode: "hosted", permissionMode: input.permissionMode, prompt: "", attachments: [] });
    ready.mutate({ projectId, mode, permissionMode, ...(input.spaceId && { spaceId: input.spaceId }), ...(agent && { agent }), ...(model && { model }), ...(effort && { effort }) });
  };
}
