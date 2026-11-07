import { BrokeringUnavailable, type BrokeredHeader, type Sandbox } from "@openorc/cloud";
import type { AgentHome } from "@openorc/agents";
import type { CloudProviderId } from "@openorc/db";
import type { HarnessId } from "@openorc/protocol";
import type { Logger } from "../transport.js";
import type { CloudAgents, CloudRunWho } from "./cloud-agents.js";

/**
 * A turn's sign-in: kept outside the sandbox where the service adds headers on the way out, else in it. Once the plan
 * refuses headers, sign-ins stay in their sandboxes until OpenOrc restarts.
 */
export class CloudBroker {
  /** The headers each open sandbox's firewall adds now, as last applied. */
  private readonly brokered = new WeakMap<Sandbox, string>();
  private refused = false;

  constructor(private readonly log: Logger) {}

  async signIn(signIn: CloudAgents[HarnessId]["signIn"], home: () => Promise<AgentHome | null>, provider: CloudProviderId, who: CloudRunWho, sandbox: Sandbox): Promise<Record<string, string>> {
    if (!sandbox.broker) return (await signIn.prepare(home, provider, who, false)).env;
    let turn = await signIn.prepare(home, provider, who, !this.refused);
    if (!(await this.apply(sandbox, turn.headers))) {
      turn = await signIn.prepare(home, provider, who, false);
      // Headers an earlier session set would replace the sign-in the sandbox holds now.
      await this.apply(sandbox, turn.headers);
    }
    return turn.env;
  }

  /**
   * The sandbox's firewall adds this turn's headers, and only these: a turn with none clears what an earlier one set.
   * Applied only when they change. False when the plan refuses it.
   */
  private async apply(sandbox: Sandbox, headers: BrokeredHeader[]): Promise<boolean> {
    const policy = JSON.stringify(headers);
    if (this.brokered.get(sandbox) === policy) return true;
    try {
      await sandbox.broker!(headers);
    } catch (error) {
      if (!(error instanceof BrokeringUnavailable)) throw error;
      this.refused = true;
      this.log.warn(`cloud sign-ins stay in their sandboxes: ${error.message}`);
      return false;
    }
    this.brokered.set(sandbox, policy);
    return true;
  }
}
