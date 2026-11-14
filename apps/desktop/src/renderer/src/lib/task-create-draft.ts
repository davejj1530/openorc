import type { OnlineTaskEnvelope, OnlineTaskParams, OnlineTaskCreation } from "@openorc/protocol";

type Input = OnlineTaskParams<"tasks.online.create">;
/** Retry the exact unsettled create before allowing a changed draft to become a second task. */
export class TaskCreateDraft {
  #pending: Input | null = null;
  constructor(readonly create: (input: Input) => Promise<OnlineTaskCreation>) {}
  get pending(): boolean {
    return this.#pending !== null;
  }
  async save(input: Input): Promise<OnlineTaskEnvelope> {
    this.#pending ??= input;
    const result = await this.create(this.#pending);
    this.#pending = null;
    if (result.state === "refused") throw new Error(result.message);
    return result;
  }
}
