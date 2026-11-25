import { useMemo, useState, type ReactElement, type ReactNode } from "react";
import { refineChoice, type AccountsProject } from "@openorc/client";
import {
  commentRecipientKey,
  orclingMentionOptions,
  sameTaskDocument,
  type CommentMentionOption,
  type CommentRecipient,
  type ModelOption,
  type Orcling,
  type TaskRefine,
  type TaskSuggestion,
} from "@openorc/protocol";
import { keptAccountName, useKeptTaskAccount, useTaskOrclings } from "../../lib/accounts-separate";
import { useRpc, useRpcMutation } from "../../lib/client";
import { useDefaultAgent } from "../../lib/default-harness";
import { readDraft, removeDraft, writeDraft } from "../../lib/drafts";
import { modelLabel } from "../../lib/model-effort-label";
import { useOrclings } from "../../lib/orclings";
import type { useTaskDocumentDraft } from "../../lib/task-document-draft";
import { labelList } from "../../lib/task-draft";
import { DocumentEditor } from "../DocumentEditor";
import { OpenOrcMark, WorkingCube } from "../OpenOrcMark";
import { useProjectClaudeAccounts, useThreadModels } from "../../lib/thread-choice";
import { AccountSelect, NoAccount } from "../task-threads/ThreadChoiceFields";
import { TaskSheet, useTaskSheet } from "../task-threads/TaskSheet";
import { TaskLabelsField, TaskTitleField } from "../task-list/TaskTextFields";
import { Button, Select, Textarea, Tooltip } from "../ui";
import { RefineSuggestion } from "./RefineSuggestion";
import "./task-refine.css";

type TaskDocument = ReturnType<typeof useTaskDocumentDraft>;
export type RefineView = { button: ReactNode; bar: ReactNode; title: ReactNode; labels: ReactNode; suggestion: ReactNode };
const NONE: RefineView = { button: null, bar: null, title: null, labels: null, suggestion: null };
const REMEMBERED = "openorc.taskRefine.recipient";
const REMEMBERED_ACCOUNT = "openorc.taskRefine.claudeAccount";

/** The Orclings and models that can refine the task, as its thread in Plan could start with them. */
function useRefineOptions(taskId: string): { models: ModelOption[] | undefined; options: CommentMentionOption[] } {
  const orclings = useTaskOrclings(taskId);
  const first = useMemo(() => orclingMentionOptions(orclings), [orclings]);
  return useThreadModels(true, first);
}

function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key: string, value: string | undefined): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Remembering the choice is a convenience; the sheet still works without it.
  }
}

function useRefineRecipient(options: CommentMentionOption[], models: ModelOption[] | undefined, choice: string): CommentMentionOption | undefined {
  const defaultAgent = useDefaultAgent();
  const key = (option: CommentMentionOption) => commentRecipientKey(option.recipient);
  const picked = options.find((option) => key(option) === choice);
  if (picked) return picked;
  const initial = refineChoice(options, models, defaultAgent ?? null, remembered(REMEMBERED));
  return options.find((option) => key(option) === initial);
}

function refinerName(recipient: CommentRecipient, models: ModelOption[] | undefined, orclings: Orcling[]): string {
  if (recipient.orclingId) return orclings.find((o) => o.id === recipient.orclingId)?.name ?? "The Orcling";
  return modelLabel(recipient, models);
}

/**
 * The Claude account a Claude model refines on, from the ones the project uses; an Orcling keeps its own. The last one
 * chosen comes back while the project still uses it.
 */
function useRefineAccount(project: AccountsProject | undefined, recipient: CommentRecipient | undefined, kept: string | undefined) {
  const claude = recipient?.agent === "claude" && !recipient.orclingId;
  const accounts = useProjectClaudeAccounts(project, kept, claude);
  const [chosen, choose] = useState(() => remembered(REMEMBERED_ACCOUNT) ?? undefined);
  if (claude && kept) return { offered: null, value: kept, choose, keptName: keptAccountName(accounts, kept) };
  const offered = claude && accounts ? accounts : null;
  const value = offered?.some((account) => account.id === chosen) ? chosen : undefined;
  return { offered, value, choose, keptName: undefined };
}

function RefineAccount({ account, recipient, disabled }: { account: ReturnType<typeof useRefineAccount>; recipient: CommentRecipient | undefined; disabled: boolean }) {
  if (account.offered) return <AccountSelect variant="sheet" label="Account" accounts={account.offered} value={account.value} disabled={disabled} onChange={account.choose} />;
  return <NoAccount variant="sheet" label="Account" reason={account.keptName ?? (recipient?.orclingId ? "Orcling’s own" : "Default")} />;
}

function rememberChoice(recipient: CommentRecipient, account: ReturnType<typeof useRefineAccount>): void {
  remember(REMEMBERED, commentRecipientKey(recipient));
  if (account.offered) remember(REMEMBERED_ACCOUNT, account.value);
}

type RefineSheetProps = {
  taskId: string;
  project: AccountsProject | undefined;
  again: boolean;
  edited: Revision | null;
  onStarted: () => void;
  document: TaskDocument;
  options: CommentMentionOption[];
  models: ModelOption[] | undefined;
  trigger: ReactElement;
};

function RefineSheet({ taskId, project, again, edited, onStarted, document, options, models, trigger }: RefineSheetProps) {
  const start = useRpcMutation("tasks.refine.start");
  const sheet = useTaskSheet();
  const [instruction, setInstruction] = useState("");
  const [choice, setChoice] = useState("");
  const selected = useRefineRecipient(options, models, choice);
  const task = useRpc("tasks.get", { id: taskId }).data;
  const account = useRefineAccount(project, selected?.recipient, useKeptTaskAccount(task));
  const submit = async () => {
    if (!selected) return;
    if (!(await document.flush())) throw new Error("The task’s latest changes couldn’t be saved, so it can’t be refined yet.");
    rememberChoice(selected.recipient, account);
    await start.mutateAsync({
      taskId,
      recipient: selected.recipient,
      ...(account.value ? { claudeAccountId: account.value } : {}),
      instruction: instruction.trim(),
      again,
      ...(again && edited ? { edited: { title: edited.title.trim(), description: edited.spec, labels: labelList(edited.labels) } } : {}),
    });
    setInstruction("");
    onStarted();
  };
  return (
    <TaskSheet
      sheet={sheet}
      title={again ? "Refine again" : "Refine this task"}
      trigger={trigger}
      side="bottom"
      align="end"
      confirm="Refine"
      pendingLabel="Starting…"
      ready={Boolean(selected)}
      onConfirm={submit}
    >
      {again && edited ? <p className="task-refine-sheet-hint">Starts from your edited version.</p> : null}
      <Textarea
        variant="sheet"
        rows={2}
        aria-label="What should change?"
        className="task-refine-sheet-instruction"
        placeholder="What should change? Optional"
        maxLength={4000}
        value={instruction}
        disabled={sheet.pending}
        autoFocus
        onChange={(event) => setInstruction(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            if (selected) void sheet.run(submit);
          }
        }}
      />
      <Select variant="sheet" aria-label="Refine with" value={selected ? commentRecipientKey(selected.recipient) : ""} disabled={sheet.pending} onChange={(event) => setChoice(event.target.value)}>
        {options.map((option) => (
          <option key={commentRecipientKey(option.recipient)} value={commentRecipientKey(option.recipient)}>
            {option.name}
          </option>
        ))}
      </Select>
      <RefineAccount account={account} recipient={selected?.recipient} disabled={sheet.pending} />
    </TaskSheet>
  );
}

/** Every state's bar, so the status region stays one element and screen readers announce each change. */
function RefineBar({ icon, who, step, children }: { icon: ReactNode; who: string; step?: string; children: ReactNode }) {
  return (
    <div className="task-refine-bar" role="status">
      <span className="task-refine-who">
        {icon} {who}
      </span>
      {step === undefined ? null : <span className="task-refine-step">{step}</span>}
      <span className="task-refine-actions">{children}</span>
    </div>
  );
}

function RefineNote({ failure, children }: { failure: string | null; children: ReactNode }) {
  return (
    <p className="task-refine-note">
      {children}
      {failure ? <span className="text-bad"> {failure}</span> : null}
    </p>
  );
}

function Asked({ refine }: { refine: TaskRefine }) {
  return refine.instruction ? <span className="task-refine-asked">You asked “{refine.instruction}”. </span> : null;
}

/**
 * The suggestion as the person edits it before using it: kept with the suggestion, so it survives leaving the page and
 * a Refine again that doesn't finish. One per task, so a suggestion a newer one replaced leaves nothing behind.
 */
type Revision = { title: string; spec: string; labels: string };
const revisionKey = (taskId: string) => `task-refine.${taskId}`;
function storedRevision(taskId: string, refineId: string): Revision | null {
  const value = readDraft<Partial<Revision & { refineId: string }>>(revisionKey(taskId), {});
  if (value.refineId !== refineId) return null;
  return typeof value.title === "string" && typeof value.spec === "string" && typeof value.labels === "string" ? { title: value.title, spec: value.spec, labels: value.labels } : null;
}

function RefineTitle({ before, after }: { before: string; after: string }) {
  if (before.trim() === after.trim()) return <div className="document-title task-refine-title">{after}</div>;
  return (
    <div className="task-refine-title-change">
      {before.trim() ? <del className="task-refine-title-old">{before}</del> : null}
      <div className="document-title task-refine-title">
        <span className="refine-ins">{after}</span>
      </div>
    </div>
  );
}

function RefineLabels({ before, after }: { before: string[]; after: string[] }) {
  const removed = before.filter((label) => !after.includes(label));
  return (
    <div className="flex flex-wrap items-center gap-2 mt-6 text-sm text-ink-3" aria-label="Suggested labels">
      <span>Labels</span>
      {after.length || removed.length ? (
        <span className="task-refine-labels">
          {after.map((label) => (
            <span key={label} className={before.includes(label) ? "text-ink-2" : "refine-ins text-ink-2"}>
              {label}
            </span>
          ))}
          {removed.map((label) => (
            <del key={label} className="refine-del">
              {label}
            </del>
          ))}
        </span>
      ) : (
        <span className="text-ink-4">None</span>
      )}
    </div>
  );
}

type OpenSheet = (again: boolean, trigger: ReactElement, edited?: Revision | null) => ReactNode;

function RefineButton({ unavailable, sheet }: { unavailable: boolean; sheet: OpenSheet }) {
  if (unavailable)
    return (
      <Tooltip label="Sign in to an agent to refine this task.">
        <span>
          <button type="button" className="task-editor-mode" disabled>
            Refine
          </button>
        </span>
      </Tooltip>
    );
  return sheet(
    false,
    <button type="button" className="task-editor-mode">
      Refine
    </button>,
  );
}

function useSuggestionEdits(taskId: string) {
  const [editing, setEditing] = useState<string | null>(null);
  const [revision, setRevision] = useState<{ id: string; value: Revision } | null>(null);
  const [imagesReady, setImagesReady] = useState(true);
  return {
    imagesReady,
    setImagesReady,
    isEditing: (refineId: string) => editing === refineId,
    toggle: (refineId: string) => setEditing(editing === refineId ? null : refineId),
    revised: (refineId: string) => (revision?.id === refineId ? revision.value : storedRevision(taskId, refineId)),
    revise: (refineId: string, value: Revision) => {
      writeDraft(revisionKey(taskId), { ...value, refineId });
      setRevision({ id: refineId, value });
    },
    forget: () => {
      removeDraft(revisionKey(taskId));
      setRevision(null);
      setEditing(null);
    },
  };
}

type BarInput = { refine: TaskRefine; name: string; failure: string | null };

function runningBar({ refine, name, failure, stopping, onStop }: BarInput & { stopping: boolean; onStop: () => void }): ReactNode {
  return (
    <>
      <RefineBar icon={<WorkingCube />} who={`${name} is refining…`} step={refine.step ?? "Reading the task"}>
        <Button size="sm" variant="ghost" disabled={stopping} onClick={onStop}>
          Stop
        </Button>
      </RefineBar>
      {refine.instruction || failure ? (
        <RefineNote failure={failure}>
          <Asked refine={refine} />
        </RefineNote>
      ) : null}
    </>
  );
}

function endedBar({ refine, name, failure, sheet, dismissing, onDismiss }: BarInput & { sheet: OpenSheet; dismissing: boolean; onDismiss: () => void }): ReactNode {
  const unchanged = refine.state === "unchanged";
  return (
    <>
      <RefineBar icon={<OpenOrcMark size={15} />} who={unchanged ? `${name} found nothing to change.` : `${name} couldn’t finish refining.`}>
        {unchanged
          ? null
          : sheet(
              false,
              <Button size="sm" variant="ghost">
                Try again
              </Button>,
            )}
        <Button size="sm" variant="ghost" disabled={dismissing} onClick={onDismiss}>
          Dismiss
        </Button>
      </RefineBar>
      <RefineNote failure={failure}>{unchanged ? refine.suggestion?.note : refine.error}</RefineNote>
    </>
  );
}

type SuggestionInput = BarInput & {
  suggestion: TaskSuggestion;
  sheet: OpenSheet;
  closing: boolean;
  close: () => void;
  document: TaskDocument;
  basePath: string | undefined;
  edits: ReturnType<typeof useSuggestionEdits>;
};

function suggestionView({ refine, suggestion, name, failure, sheet, closing, close, document, basePath, edits }: SuggestionInput): RefineView {
  const current = { title: document.draft.title, spec: document.draft.spec, labels: labelList(document.draft.labels) };
  const movedOn = !sameTaskDocument(refine.base, current);
  const revised = edits.revised(refine.id);
  const proposal = revised ?? { title: suggestion.title, spec: suggestion.description, labels: suggestion.labels.join(", ") };
  const editing = edits.isEditing(refine.id);
  const revise = (patch: Partial<Revision>) => edits.revise(refine.id, { ...proposal, ...patch });
  const use = () => {
    document.body.current?.replace(proposal.spec);
    document.patch({ title: proposal.title.trim(), spec: proposal.spec, labels: labelList(proposal.labels).join(", ") });
    close();
  };
  let who = `Suggested by ${name}`;
  if (editing) who = `Editing ${name}’s suggestion`;
  else if (revised) who = `Suggested by ${name}, with your edits`;
  const fields = editing
    ? {
        title: <TaskTitleField label="Suggested title" value={proposal.title} onChange={(title) => revise({ title })} />,
        labels: <TaskLabelsField label="Suggested labels" value={proposal.labels} onChange={(labels) => revise({ labels })} />,
        suggestion: <DocumentEditor key={refine.id} value={proposal.spec} onChange={(spec) => revise({ spec })} onReadyChange={edits.setImagesReady} basePath={basePath} />,
      }
    : {
        title: <RefineTitle before={current.title} after={proposal.title} />,
        labels: <RefineLabels before={current.labels} after={labelList(proposal.labels)} />,
        suggestion: <RefineSuggestion key={refine.id} base={current.spec} suggestion={proposal.spec} basePath={basePath} />,
      };
  return {
    button: null,
    bar: (
      <>
        <RefineBar icon={<OpenOrcMark size={15} />} who={who}>
          {sheet(
            true,
            <Button size="sm" variant="ghost">
              Refine again
            </Button>,
            revised,
          )}
          <Button size="sm" variant="ghost" onClick={() => edits.toggle(refine.id)}>
            {editing ? "Show changes" : "Edit"}
          </Button>
          <Button size="sm" variant="ghost" disabled={closing} onClick={close}>
            Dismiss
          </Button>
          <Button size="sm" variant="primary" disabled={closing || !proposal.title.trim() || (editing && !edits.imagesReady)} onClick={use}>
            Use suggestion
          </Button>
        </RefineBar>
        <RefineNote failure={failure ?? (refine.error ? `Refining again didn’t finish: ${refine.error}` : null)}>
          <Asked refine={refine} />
          {suggestion.note}
          {movedOn ? <span className="task-refine-asked"> Suggested from an earlier version. Changes to the task since aren’t in it.</span> : null}
        </RefineNote>
      </>
    ),
    ...fields,
  };
}

/**
 * Refine's parts of the task page, for a task on this Mac. Using a suggestion is an edit like any other: autosave keeps
 * it and, in rich text, ⌘Z in the description undoes it.
 */
export function useTaskRefine(taskId: string, document: TaskDocument, basePath?: string, project?: AccountsProject): RefineView {
  const query = useRpc("tasks.refine.get", { taskId }, { refetchInterval: (q) => (q.state.data?.state === "running" ? 2000 : false) });
  const { models, options } = useRefineOptions(taskId);
  const orclings = useOrclings();
  const stop = useRpcMutation("tasks.refine.stop");
  const dismiss = useRpcMutation("tasks.refine.dismiss");
  // Put away at once: the refetch that confirms it would otherwise show the suggestion a moment longer.
  const [putAway, setPutAway] = useState<string | null>(null);
  const edits = useSuggestionEdits(taskId);

  const refine = query.data && query.data.state !== "cancelled" && query.data.id !== putAway ? query.data : null;
  // A new Refine starts without the last one's failure to stop or put away.
  const started = () => {
    stop.reset();
    dismiss.reset();
  };
  const sheet: OpenSheet = (again, trigger, edited = null) => (
    <RefineSheet taskId={taskId} project={project} again={again} edited={edited} onStarted={started} document={document} options={options} models={models} trigger={trigger} />
  );
  if (!refine) return { ...NONE, button: <RefineButton unavailable={Boolean(models && !options.length)} sheet={sheet} /> };

  const barInput = { refine, name: refinerName(refine.recipient, models, orclings), failure: stop.error?.message ?? dismiss.error?.message ?? null };
  const close = () => {
    const { id } = refine;
    setPutAway(id);
    // Shown again with the person's edits when that fails, so its note says why.
    void dismiss.mutateAsync({ taskId }).then(
      () => edits.forget(),
      () => setPutAway(null),
    );
  };
  if (refine.state === "running") return { ...NONE, bar: runningBar({ ...barInput, stopping: stop.isPending, onStop: () => stop.mutate({ taskId }) }) };
  if (refine.state === "error" || refine.state === "unchanged" || !refine.suggestion) return { ...NONE, bar: endedBar({ ...barInput, sheet, dismissing: dismiss.isPending, onDismiss: close }) };
  return suggestionView({ ...barInput, suggestion: refine.suggestion, sheet, closing: dismiss.isPending, close, document, basePath, edits });
}
