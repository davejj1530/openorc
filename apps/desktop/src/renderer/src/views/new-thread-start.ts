import type { Project, RpcParams, RpcResults, WorkspaceMode } from "@openorc/protocol";
import { readDraft, writeDraft } from "../lib/drafts";
import { newThreadStartInput, readNewThreadDraft, teamLaunchRequest, writeNewThreadDraft, type NewThreadDraft } from "../lib/new-thread-draft";

interface StartNewThreadInput {
  draft: NewThreadDraft;
  project: Project;
  isWorkspace: boolean;
  workspaceMode: WorkspaceMode;
  permissionMode: RpcParams<"threads.start">["permissionMode"];
  text: string;
  attachments: string[];
  launch: (params: RpcParams<"threads.start">) => Promise<RpcResults["threads.start"]>;
  onPendingDraft: (draft: NewThreadDraft) => void;
}

/** A successful launch clears only the prompt and images it accepted, preserving later edits. */
export async function startNewThread(input: StartNewThreadInput): Promise<string> {
  const { draft, project, attachments } = input;
  const payload = newThreadStartInput(draft, {
    workspaceMode: input.workspaceMode,
    permissionMode: input.permissionMode,
    prompt: input.text || "See the attached image.",
    attachments,
  });
  const request = draft.target.kind === "team" ? teamLaunchRequest(draft.launchRequest, JSON.stringify(payload)) : null;
  if (request) {
    const pendingDraft = { ...draft, launchRequest: request };
    input.onPendingDraft(pendingDraft);
    if (!writeNewThreadDraft(pendingDraft)) throw new Error("This team launch could not be saved for retry. Free some local storage and try again; your message and images are kept here.");
  }
  const { thread } = await input.launch({
    ...payload,
    ...(input.isWorkspace ? { workingDirectory: draft.workingDirectory ?? project.rootPath } : {}),
    ...(request ? { requestKey: request.key } : {}),
  });

  const latest = readNewThreadDraft(draft.projectId);
  if (latest.prompt === draft.prompt && (!request || latest.launchRequest?.key === request.key)) writeNewThreadDraft({ ...latest, prompt: "", launchRequest: null });
  const attachmentKey = `newthread.${draft.projectId}.attachments`;
  const images = readDraft(attachmentKey, { attachments: [] as { path: string }[] });
  if (Array.isArray(images.attachments)) writeDraft(attachmentKey, { attachments: images.attachments.filter((image) => !attachments.includes(image.path)) });
  return thread.id;
}
