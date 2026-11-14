import { newThreadStartInput, type NewThreadDraft, type NewThreadPlace } from "@openorc/client";
import type { Project, RpcParams, RpcResults } from "@openorc/protocol";
import { readDraft, writeDraft } from "../lib/drafts";
import { readNewThreadDraft, writeNewThreadDraft } from "../lib/new-thread-draft";

interface StartNewThreadInput {
  draft: NewThreadDraft;
  project: Project;
  isWorkspace: boolean;
  workspaceMode: NewThreadPlace;
  permissionMode: RpcParams<"threads.start">["permissionMode"];
  text: string;
  attachments: string[];
  /** A cloud start's files: its request id while unchanged, forgotten once the thread exists. */
  files?: { requestId(intent: { text: string; attachments: string[]; settings: unknown }): Promise<string | undefined>; started(): void };
  launch: (params: RpcParams<"threads.start">) => Promise<RpcResults["threads.start"]>;
}

/** A successful launch clears only the prompt and images it accepted, preserving later edits. */
export async function startNewThread(input: StartNewThreadInput): Promise<string> {
  const { draft, project, attachments } = input;
  const settings = { target: draft.target, mode: draft.mode, permission: input.permissionMode };
  const requestId = input.files ? await input.files.requestId({ text: input.text, attachments, settings }) : undefined;
  const payload = newThreadStartInput(draft, {
    workspaceMode: input.workspaceMode,
    permissionMode: input.permissionMode,
    prompt: input.text,
    attachments,
  });
  const { thread } = await input.launch({
    ...payload,
    ...(input.isWorkspace ? { workingDirectory: draft.workingDirectory ?? project.rootPath } : {}),
    ...(requestId ? { requestId } : {}),
  });
  input.files?.started();

  const latest = readNewThreadDraft(draft.projectId);
  if (latest.prompt === draft.prompt) writeNewThreadDraft({ ...latest, prompt: "" });
  const attachmentKey = `newthread.${draft.projectId}.attachments`;
  const images = readDraft(attachmentKey, { attachments: [] as { path: string }[] });
  if (Array.isArray(images.attachments)) writeDraft(attachmentKey, { attachments: images.attachments.filter((image) => !attachments.includes(image.path)) });
  return thread.id;
}
