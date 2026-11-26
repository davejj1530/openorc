import type { OnlineTask, OnlineTaskMutation, OnlineTaskParams, OnlineTaskPatch, OnlineTaskRef } from "@openorc/protocol";
import type { TaskDocumentDraft, taskDraftPatch } from "./task-draft";

type Words = ReturnType<typeof taskDraftPatch>;
type Input = OnlineTaskParams<"tasks.online.update">;
type SaveState = { task: OnlineTask; conflict: OnlineTask | null; saving: boolean; error: Error | null; propertyError: string | null };

/** A document keeps the exact unsettled write until its receipt is known. */
export class TaskSaveController {
  #state: SaveState;
  #pending: Input | null = null;
  #pendingProperty: Input | null = null;
  #documentRevision: number | null = null;
  #listeners = new Set<() => void>();
  constructor(
    readonly reference: OnlineTaskRef,
    task: OnlineTask,
    readonly send: (input: Input) => Promise<OnlineTaskMutation>,
    recoveredRevision?: number | null,
  ) {
    this.#state = { task, conflict: null, saving: false, error: null, propertyError: null };
    this.#check(task);
    if (recoveredRevision !== undefined) {
      this.#documentRevision = recoveredRevision;
      if (recoveredRevision !== task.revision) this.#state = { ...this.#state, conflict: task, error: new Error("This task changed. Your words are kept here.") };
    }
  }
  markEdited(): void {
    this.#documentRevision ??= this.#state.task.revision;
  }
  markClean(): void {
    this.#documentRevision = null;
  }
  get draftRevision(): number | null {
    return this.#documentRevision;
  }
  getSnapshot = (): SaveState => this.#state;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  #set(patch: Partial<SaveState>): void {
    this.#state = { ...this.#state, ...patch };
    this.#listeners.forEach((listener) => listener());
  }
  #check(task: OnlineTask): void {
    if (task.id !== this.reference.id || task.spaceId !== this.reference.spaceId || task.projectId !== this.reference.projectId) throw new Error("The task's project changed. Reopen it from Tasks.");
  }
  observe(task: OnlineTask): void {
    this.#check(task);
    if (task !== this.#state.task && task.revision >= this.#state.task.revision) this.#set({ task, ...(this.#state.conflict && { conflict: task }) });
  }
  #input(patch: OnlineTaskPatch, revision = this.#state.task.revision): Input {
    return { spaceId: this.reference.spaceId, id: this.reference.id, ifRevision: revision, requestId: crypto.randomUUID(), patch };
  }
  async #write(input: Input): Promise<void> {
    const result = await this.send(input);
    this.#check(result.task);
    this.observe(result.task);
    this.#pending = null;
    if (result.state === "saved") this.#documentRevision = result.task.revision;
    if (result.state === "conflict") {
      this.#set({ conflict: result.task });
      throw new Error("This task changed. Your words are kept here.");
    }
  }
  async save(words: Words): Promise<void> {
    if (this.#state.conflict) throw new Error("Choose which version to save before continuing.");
    this.#set({ saving: true, error: null });
    try {
      const pending = this.#pending;
      if (pending) await this.#write(pending);
      if (!pending || JSON.stringify(pending.patch) !== JSON.stringify(words)) {
        this.#pending = this.#input(words, this.#documentRevision ?? this.#state.task.revision);
        await this.#write(this.#pending);
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.#set({ error: failure });
      throw failure;
    } finally {
      this.#set({ saving: false });
    }
  }
  async overwrite(words: Words): Promise<void> {
    if (!this.#state.conflict) return this.save(words);
    this.allowOverwrite();
    await this.save(words);
  }
  allowOverwrite(): void {
    this.#documentRevision = this.#state.task.revision;
    this.#set({ conflict: null, error: null });
  }
  useSavedVersion(): TaskDocumentDraft {
    const task = this.#state.task;
    this.#pending = null;
    this.#documentRevision = null;
    this.#set({ conflict: null, error: null });
    return { title: task.title, spec: task.spec ?? "", labels: task.labels.join(", ") };
  }
  async #writeProperty(input: Input): Promise<boolean> {
    const result = await this.send(input);
    this.#check(result.task);
    if (result.state === "saved" && this.#documentRevision === input.ifRevision) this.#documentRevision = result.task.revision;
    this.observe(result.task);
    this.#pendingProperty = null;
    if (result.state === "conflict") this.#set({ propertyError: "This property changed. Choose again to update it." });
    return result.state === "saved";
  }
  /** One property changed; `ask` carries what the change asks beside it, as its column's agent on the person's own computer. */
  async property(patch: OnlineTaskPatch, ask: Pick<Input, "runHere"> = {}): Promise<void> {
    this.#set({ propertyError: null });
    try {
      const pending = this.#pendingProperty;
      if (pending && !(await this.#writeProperty(pending))) return;
      if (!pending || JSON.stringify(pending.patch) !== JSON.stringify(patch)) {
        this.#pendingProperty = { ...this.#input(patch), ...ask };
        await this.#writeProperty(this.#pendingProperty);
      }
    } catch (error) {
      this.#set({ propertyError: error instanceof Error ? error.message : String(error) });
    }
  }
}
