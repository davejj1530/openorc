import type { HostedFileScope, OnlineTask, OnlineTaskExecutionParams, OnlineTaskPreparation, OnlineTaskRef, OnlineTaskThread } from "@openorc/protocol";
import type { HostedTaskDraftScope } from "./task-thread-storage";

interface OpenTask {
  scope: HostedTaskDraftScope;
  task(): OnlineTask;
  flush(): Promise<boolean>;
  current(): boolean;
  files(scope: HostedFileScope, threadId: string): Promise<number>;
  stage(scope: HostedTaskDraftScope, reference: OnlineTaskRef, result: OnlineTaskThread, files: number): void;
  navigate(threadId: string): void;
}

export class TaskThreadOpener {
  #request: OnlineTaskExecutionParams | null = null;
  constructor(
    readonly reference: OnlineTaskRef,
    readonly prepare: (input: OnlineTaskExecutionParams) => Promise<OnlineTaskPreparation>,
  ) {}
  async open(input: OpenTask): Promise<OnlineTaskPreparation | null> {
    if (!(await input.flush())) return null;
    this.#check(input);
    const task = input.task();
    const ref = this.reference;
    if (task.id !== ref.id || task.projectId !== ref.projectId || task.spaceId !== ref.spaceId) throw new Error("This task isn't available here.");
    this.#request ??= { spaceId: ref.spaceId, id: ref.id, ifRevision: task.revision, requestId: crypto.randomUUID() };
    const result = await this.prepare(this.#request);
    this.#check(input);
    if (result.state === "conflict") {
      this.#request = null;
      return result;
    }
    const scope: HostedFileScope = { ...input.scope, destination: { kind: "hosted", projectId: ref.projectId, threadId: result.threadId } };
    const files = await input.files(scope, result.threadId);
    this.#check(input);
    input.stage(input.scope, ref, result, files);
    this.#request = null;
    input.navigate(result.threadId);
    return result;
  }
  #check(input: OpenTask): void {
    if (input.scope.accountId !== this.reference.accountId || input.scope.spaceId !== this.reference.spaceId || !input.current()) throw new Error("Project access changed. Try again.");
  }
}
