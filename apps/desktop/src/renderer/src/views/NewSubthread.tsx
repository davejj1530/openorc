import { offeredAccount, projectAccountChoice, type ModelChoice } from "@openorc/client";
import { executionMode, type Thread } from "@openorc/protocol";
import { useEffect, useRef, useState } from "react";
import { Composer } from "../components/Composer";
import { DitherBackdrop } from "../components/DitherBackdrop";
import { ComposerModelPicker, ModelPicker } from "../components/ModelPicker";
import type { PickerAccounts } from "../components/ModelPickerAccounts";
import { ProjectActivity } from "../components/ProjectActivity";
import { TopBar } from "../components/TopBar";
import { Button } from "../components/ui";
import { ClaudeAccountScope } from "../lib/claude-account";
import { useRpc, useRpcMutation } from "../lib/client";
import { readDraft, writeDraft } from "../lib/drafts";
import { openThread, useRouter } from "../lib/router";
import { useComposerSuggestions } from "../lib/connector-mentions";

const draftKey = (parentId: string) => `subthread.${parentId}`;

/** Starts a thread under another, in its folder, on the parent's model, account and settings until you change them. */
export function NewSubthread({ parentId }: { parentId: string }) {
  const parent = useRpc("threads.get", { id: parentId });
  if (parent.error) {
    return (
      <main className="workspace-main well flex flex-1 flex-col min-w-0 min-h-0">
        <TopBar>{null}</TopBar>
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
  const { list: accounts, picker: accountPicker, claudeAccountId } = useSubthreadAccount(parent, start.isPending, () => start.reset());
  const accountsMissing = choice?.agent === "claude" && !accounts.data ? (accounts.error?.message ?? "Loading Claude accounts…") : null;
  const suggestions = useComposerSuggestions({ kind: "thread", id: parent.id }, choice?.agent, executionMode(mode, permission), claudeAccountId);
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
    if (accountsMissing) throw new Error(accountsMissing);
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
        <TopBar>{null}</TopBar>
        <div className="new-thread-body flex-1 min-h-0 overflow-y-auto">
          <DitherBackdrop />
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
                  <ComposerModelPicker value={choice} onChange={chooseModel} onSelectModel={chooseModel} accounts={accountPicker} disabled={start.isPending} />
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
              {...suggestions}
              busy={start.isPending}
              disabledReason={choice ? accountsMissing : "Choose a model first."}
              error={start.error?.message ?? null}
            />
          </div>
          <ProjectActivity projectId={parent.projectId} />
        </div>
      </main>
    </ClaudeAccountScope>
  );
}

/**
 * The Claude accounts a subthread can start on: the ones its project uses, starting on the parent's while the project
 * still uses it, else on the project's default.
 */
function useSubthreadAccount(parent: Thread, starting: boolean, onChoose: () => void) {
  const list = useRpc("claude.accounts.list", {});
  const project = useRpc("projects.get", { id: parent.projectId });
  const [chosen, setChosen] = useState(parent.claudeAccountId ?? undefined);
  const choice = list.data && (project.data !== undefined || project.error) ? projectAccountChoice(project.data, list.data) : undefined;
  const claudeAccountId = offeredAccount(choice, chosen) ?? choice?.defaultId;
  const picker: PickerAccounts | undefined =
    choice && claudeAccountId
      ? {
          accounts: choice.accounts,
          current: claudeAccountId,
          choose: (id) => {
            setChosen(id);
            onChoose();
          },
          blocked: starting ? "Starting the thread…" : undefined,
          project: choice.restricted && project.data ? { id: project.data.id, name: project.data.name } : undefined,
        }
      : undefined;
  return { list, picker, claudeAccountId };
}
