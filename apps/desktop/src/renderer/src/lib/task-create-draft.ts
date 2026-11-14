import type { OnlineTaskEnvelope, OnlineTaskParams, OnlineTaskCreation } from "@openorc/protocol";

type Input = OnlineTaskParams<"tasks.online.create">;
/** Retry the exact unsettled create before allowing a changed draft to become a second task. */
export class TaskCreateDraft {
  #pending: Input | null = null;
  #uncertain = false;
  constructor(readonly create: (input: Input) => Promise<OnlineTaskCreation>) {}
  get pending(): boolean {
    return this.#pending !== null;
  }
  async save(input: Input): Promise<OnlineTaskEnvelope> {
    this.#pending ??= input;
    let result: OnlineTaskCreation;
    try {
      result = await this.create(this.#pending);
    } catch (error) {
      this.#uncertain = true;
      throw error;
    }
    if (result.state === "refused" && this.#uncertain) throw new Error(result.message);
    this.#pending = null;
    this.#uncertain = false;
    if (result.state === "refused") throw new Error(result.message);
    return result;
  }
}
