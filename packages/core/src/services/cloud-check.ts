import { CHECK_STEPS, checkSandbox, type CheckProgress, type RunnerFile, type Sandbox, type SandboxProvider } from "@openorc/cloud";
import type { CloudCheck } from "@openorc/protocol";
import type { Logger } from "../transport.js";

/** Where a new cloud conversation would run, and what its runner needs there. */
export interface CloudCheckTarget {
  provider: SandboxProvider;
  files: RunnerFile[];
  node?: string;
  /** Claude Code in the check's sandbox, put there as a thread's first turn puts it. */
  agent?: (sandbox: Sandbox) => Promise<void>;
}

/** The cloud check, one run at a time. The last run's steps stay for Settings until OpenOrc quits. */
export class CloudChecks {
  private current: CloudCheck | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly target: () => Promise<CloudCheckTarget>,
    private readonly changed: () => void,
    private readonly log: Logger,
  ) {}

  status(): CloudCheck | null {
    return this.current;
  }

  /** Starts a check unless one is running. Resolves once it has started; its progress arrives through `changed`. */
  async start(): Promise<void> {
    if (this.running) return;
    const { provider, files, node, agent } = await this.target();
    if (this.running) return;
    const check: CloudCheck = { provider: provider.id, passed: null, steps: CHECK_STEPS.map((step) => ({ step, state: "pending", ms: null, detail: null, error: null })) };
    this.current = check;
    this.changed();
    const report = (progress: CheckProgress) => {
      const entry = check.steps.find((candidate) => candidate.step === progress.step);
      if (entry) Object.assign(entry, { state: progress.state, ms: progress.ms ?? null, detail: progress.detail ?? null, error: progress.error ?? null });
      this.changed();
    };
    this.running = checkSandbox(provider, { files, ...(node ? { node } : {}), ...(agent ? { agent } : {}), report })
      .then((passed) => {
        check.passed = passed;
        const failed = check.steps.find((entry) => entry.state === "failed");
        const why = failed ? ` at ${failed.step}: ${failed.error}` : "";
        this.log.info(`cloud check on ${provider.id} ${passed ? "passed" : `failed${why}`}`);
      })
      .catch((error: unknown) => {
        check.passed = false;
        this.log.warn(`cloud check on ${provider.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.running = null;
        this.changed();
      });
  }
}
