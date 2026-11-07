import type { ModelChoice } from "@openorc/client";
import type { Thread } from "@openorc/protocol";
import { useEffect, useRef, useState } from "react";
import { Composer } from "../components/Composer";
import { ComposerModelPicker, ModelPicker } from "../components/ModelPicker";
import { TopBar } from "../components/TopBar";
import { Button } from "../components/ui";
import { ClaudeAccountScope } from "../lib/claude-account";
import { useRpc, useRpcMutation } from "../lib/client";
import { readDraft, writeDraft } from "../lib/drafts";
import { openThread, useRouter } from "../lib/router";
import { useSkillCommands } from "../lib/skill-commands";

const draftKey = (parentId: string) => `subthread.${parentId}`;

/** Starts a thread under another, in its folder, on the parent's model and settings until you change them. */
export function NewSubthread({ parentId }: { parentId: string }) {
  const parent = useRpc("threads.get", { id: parentId });
  if (parent.error) {
    return (
      <main className="workspace-main well flex flex-1 flex-col min-w-0 min-h-0">
        <TopBar showProject={false}>{null}</TopBar>
        <div className="new-thread-body flex-1 min-h-0">
          <div className="new-thread-column">
            <p role="alert" className="text-sm text-bad">
              {parent.error.message}
            </p>
            <Button size="sm" className="mt-3" onClick={() => void parent.refetch()}>
              Retry
            </Button>
          </div>
        </div>
      </main>
    );
  }
  return parent.data ? <SubthreadComposer key={parent.data.id} parent={parent.data} /> : null;
}

function SubthreadComposer({ parent }: { parent: Thread }) {
  const [prompt, setPrompt] = useState(() => readDraft(draftKey(parent.id), { prompt: "" }).prompt);
  const [choice, setChoice] = useState<ModelChoice | null>(() => (parent.model ? { agent: parent.agent, model: parent.model, effort: parent.effort, fastMode: parent.fastMode } : null));
  const [mode, setMode] = useState(parent.mode);
  const [permission, setPermission] = useState(parent.permissionMode);
  const start = useRpcMutation("threads.start");
  const claudeAccountId = parent.claudeAccountId ?? undefined;
  const skills = useSkillCommands(parent.projectId, choice?.agent, parent.workingDirectory ?? undefined, claudeAccountId);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const changePrompt = (text: string) => {
    setPrompt(text);
    writeDraft(draftKey(parent.id), { prompt: text });
    start.reset();
  };
  const submit = async (text: string, attachments: string[]) => {
    if (!choice) throw new Error("Choose a model first.");
    const { thread } = await start.mutateAsync({
      projectId: parent.projectId,
      parentThreadId: parent.id,
      agent: choice.agent,
      model: choice.model,
      effort: choice.effort ?? undefined,
      fastMode: Boolean(choice.fastMode),
      mode,
      permissionMode: permission,
      prompt: text || "See the attached image.",
      attachments,
      ...(claudeAccountId ? { claudeAccountId } : {}),
    });
    if (readDraft(draftKey(parent.id), { prompt: "" }).prompt === text) writeDraft(draftKey(parent.id), { prompt: "" });
    if (mounted.current && useRouter.getState().route.view === "newsubthread") openThread(thread.id);
  };
  const chooseModel = (next: ModelChoice) => {
    setChoice(next);
    start.reset();
  };

  return (
    <ClaudeAccountScope id={claudeAccountId ?? "claude-cli"}>
      <main className="workspace-main well flex flex-1 flex-col min-w-0 min-h-0">
        <TopBar showProject={false}>{null}</TopBar>
        <div className="new-thread-body flex-1 min-h-0 overflow-y-auto">
          <div className="new-thread-column">
            <h1 className="new-thread-question">
              What should we work on under{" "}
              <button className="new-thread-question-project" title={parent.title} onClick={() => openThread(parent.id)}>
                {parent.title}
              </button>
              ?
            </h1>
            <Composer
              draftKey={`${draftKey(parent.id)}.attachments`}
              autoFocus
              value={prompt}
              onChange={changePrompt}
              onSubmit={submit}
              placeholder="Ask OpenOrc to build, fix bugs, explore"
              size="lg"
              presentation="new-thread"
              model={choice}
              onModel={chooseModel}
              modelControl={
                choice ? (
                  <ComposerModelPicker value={choice} onChange={chooseModel} onSelectModel={chooseModel} disabled={start.isPending} />
                ) : (
                  <ModelPicker value={null} onChange={chooseModel} disabled={start.isPending} />
                )
              }
              mode={mode}
              onMode={setMode}
              permission={permission}
              onPermission={setPermission}
              settingsDisabled={start.isPending}
              location={{ label: null, branch: parent.branch, directory: parent.worktreePath ?? parent.workingDirectory ?? undefined }}
              fileSearch={{ kind: "thread", id: parent.id }}
              {...skills}
              busy={start.isPending}
              disabledReason={choice ? null : "Choose a model first."}
              error={start.error?.message ?? null}
            />
          </div>
        </div>
      </main>
    </ClaudeAccountScope>
  );
}
