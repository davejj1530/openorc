import { spaceNavigation } from "../lib/space-navigation";
import { useSpaceThread } from "../lib/space-queries";
import { offeredAccount, projectAccountChoice, type ModelChoice } from "@openorc/client";
import { executionMode, placeOf, PLACES, type ThreadSummary } from "@openorc/protocol";
import { useState } from "react";
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
import { useNewThreadFiles } from "../lib/new-thread-files";
import { useMounted } from "../lib/use-mounted";

const draftKey = (parentId: string) => `subthread.${parentId}`;

/** Starts a thread under another, in its folder, on the parent's model, account and settings until you change them. */
export function NewSubthread({ parentId }: { parentId: string }) {
  const parent = useSpaceThread(parentId);
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

function SubthreadComposer({ parent }: { parent: ThreadSummary }) {
  const [prompt, setPrompt] = useState(() => readDraft(draftKey(parent.id), { prompt: "" }).prompt);
  const [choice, setChoice] = useState<ModelChoice | null>(() => (parent.model ? { agent: parent.agent, model: parent.model, effort: parent.effort, fastMode: parent.fastMode } : null));
  const [mode, setMode] = useState(parent.mode);
  const [permission, setPermission] = useState(parent.permissionMode);
  const start = useRpcMutation("threads.start");
  const { files, picker: accountPicker, claudeAccountId, missing } = useSubthreadPlace(parent, start.isPending, () => start.reset());
  const accountsMissing = choice?.agent === "claude" ? missing : null;
  const suggestions = useComposerSuggestions({ kind: "thread", id: parent.id }, choice?.agent, executionMode(mode, permission), claudeAccountId);
  const mounted = useMounted();
  const changePrompt = (text: string) => {
    setPrompt(text);
    writeDraft(draftKey(parent.id), { prompt: text });
    start.reset();
  };
  const submit = async (text: string, attachments: string[]) => {
    if (!choice) throw new Error("Choose a model first.");
    if (accountsMissing) throw new Error(accountsMissing);
    const scope = spaceNavigation.getState();
    const { thread } = await start.mutateAsync({
      ...(scope.current ? { spaceId: scope.current } : {}),
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
    if (scope.current) spaceNavigation.getState().observe(scope.current, [thread], scope.key);
    if (mounted.current && spaceNavigation.getState().generation === scope.generation && useRouter.getState().route.view === "newsubthread") openThread(thread.id);
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
              <button className="new-thread-question-project" data-tip={parent.title} onClick={() => openThread(parent.id)}>
                {parent.title}
              </button>
              ?
            </h1>
            <Composer
              draftKey={files.draftKey}
              hostedFiles={files.hostedFiles}
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
 * Where a subthread starts and on what. Under a cloud thread it starts on OpenOrc Cloud too, on the person's cloud
 * sign-in and with the cloud's files; under a thread here, on this Mac with its project's Claude accounts. `missing`
 * says why a Claude subthread here can't start yet.
 */
function useSubthreadPlace(parent: ThreadSummary, starting: boolean, onChoose: () => void) {
  const cloud = placeOf(parent) === PLACES.hosted;
  const hosted = useNewThreadFiles(parent.projectId, cloud, parent.id);
  const { list, picker, claudeAccountId } = useSubthreadAccount(parent, !cloud, starting, onChoose);
  const files = cloud ? hosted : { draftKey: `${draftKey(parent.id)}.attachments`, hostedFiles: undefined };
  return { files, picker, claudeAccountId, missing: cloud || list.data ? null : (list.error?.message ?? "Loading Claude accounts…") };
}

/**
 * The Claude accounts a subthread can start on: the ones its project uses, starting on the parent's while the project
 * still uses it, else on the project's default.
 */
function useSubthreadAccount(parent: ThreadSummary, enabled: boolean, starting: boolean, onChoose: () => void) {
  const list = useRpc("claude.accounts.list", {}, { enabled });
  const project = useRpc("projects.get", { id: parent.projectId }, { enabled });
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
