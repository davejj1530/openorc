import { CHECK_STEPS, checkSandbox, type CheckProgress, type RunnerFile, type SandboxProvider } from "@openorc/cloud";
import type { CloudCheck } from "@openorc/protocol";
import type { Logger } from "../transport.js";

/** Where a new cloud conversation would run, and what its runner needs there. */
export interface CloudCheckTarget {
  provider: SandboxProvider;
  files: RunnerFile[];
  node?: string;
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
    const { provider, files, node } = await this.target();
    if (this.running) return;
    const check: CloudCheck = { provider: provider.id, passed: null, steps: CHECK_STEPS.map((step) => ({ step, state: "pending", ms: null, detail: null, error: null })) };
    this.current = check;
    this.changed();
    const report = (progress: CheckProgress) => {
      const entry = check.steps.find((candidate) => candidate.step === progress.step);
      if (entry) Object.assign(entry, { state: progress.state, ms: progress.ms ?? null, detail: progress.detail ?? null, error: progress.error ?? null });
      this.changed();
    };
    this.running = checkSandbox(provider, { files, ...(node ? { node } : {}), report })
      .then((passed) => {
        check.passed = passed;
        this.log.info(`cloud check on ${provider.id} ${passed ? "passed" : "failed"}`);
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
