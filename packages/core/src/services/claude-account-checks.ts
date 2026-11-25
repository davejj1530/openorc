import type { ClaudeAccountService } from "./claude-accounts.js";
import type { ShellEnvironment } from "./shell-environment.js";
import type { SystemService } from "./system.js";

/** The agent checks as a Claude account sees them: each account is inspected in its own environment. */
export class ClaudeAccountChecks {
  constructor(
    private readonly system: SystemService,
    private readonly environment: ShellEnvironment,
    private readonly accounts: Pick<ClaudeAccountService, "inspectionEnvironment">,
  ) {}

  /** A reading for one account; no account is the default one. */
  async info(id?: string | null, refresh = false) {
    if (refresh) await this.environment.refresh();
    return this.system.infoFor(this.inspection(id));
  }

  /** What a window shows at once: the kept reading unless a fresh one is asked for. */
  shown(refresh = false, id?: string) {
    if (refresh) return id ? this.info(id, true) : this.system.info(true);
    return this.system.shown(id ? this.inspection(id) : this.environment.current());
  }

  /** The default account's kept reading. */
  shownDefault() {
    return this.system.shown(this.inspection());
  }

  private inspection(id?: string | null) {
    return this.accounts.inspectionEnvironment(this.environment.current(), id ?? undefined);
  }
}
