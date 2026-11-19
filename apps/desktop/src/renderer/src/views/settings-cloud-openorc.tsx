import { HOSTED_AGENTS, type AccountStatus, type HostedAgent } from "@openorc/protocol";
import { useRpc, useRpcMutation } from "../lib/client";
import { AgentAccounts } from "./settings-cloud-openorc-accounts";
import { GithubRow } from "./settings-cloud-openorc-projects";
import { AgentSignInRow } from "./settings-cloud-openorc-sign-ins";
import { Failure } from "./settings-secret-field";
import { Section, Toggle } from "./settings-shared";

type ProAccount = Extract<AccountStatus, { state: "signed-in" }>;

/** OpenOrc Cloud's part of Settings > Cloud: shown to a Pro person, whom it runs threads for. */
function proAccount(account: AccountStatus | undefined): ProAccount | null {
  return account?.state === "signed-in" && account.plan.pro ? account : null;
}

/**
 * OpenOrc Cloud for a Pro person: each agent's accounts there, or on a server that keeps one per agent its one
 * sign-in, with the ways to sign in, and their GitHub. The server's answers are the state.
 */
export function OpenOrcCloudSection({ active }: { active: boolean }) {
  const account = proAccount(useRpc("account.status", {}, { enabled: active }).data);
  if (!account) return null;
  const { signIns, signingIn } = account;
  const rowsOf = (agent: HostedAgent) => signIns?.filter((row) => row.agent === agent) ?? [];
  if (signIns && account.agentAccounts)
    return (
      <Section title="OpenOrc Cloud" flush>
        <div className="flex flex-col gap-3">
          {HOSTED_AGENTS.map((agent) => (
            <AgentAccounts key={agent} agent={agent} rows={rowsOf(agent)} work={signingIn[agent]} />
          ))}
          {account.switchAccountsAtLimit !== undefined && HOSTED_AGENTS.some((agent) => rowsOf(agent).length > 1) ? <SwitchAtLimit on={account.switchAccountsAtLimit} /> : null}
          <div className="settings-group">
            <GithubRow account={account} />
          </div>
        </div>
      </Section>
    );
  return (
    <Section title="OpenOrc Cloud">
      {signIns ? HOSTED_AGENTS.map((agent) => <AgentSignInRow key={agent} agent={agent} rows={rowsOf(agent)} work={signingIn[agent]} />) : null}
      <GithubRow account={account} />
    </Section>
  );
}

/**
 * Whether a cloud turn that ends at its account's usage limit goes on with another of the person's accounts, as this
 * Mac's Claude accounts do; offered once an agent has more than one.
 */
function SwitchAtLimit({ on }: { on: boolean }) {
  const set = useRpcMutation("account.setSwitchAtLimit");
  return (
    <div className="settings-group">
      <Toggle
        label="Switch accounts at usage limits"
        checked={set.variables && set.isPending ? set.variables.switchAccountsAtLimit : on}
        disabled={set.isPending}
        onChange={(next) => set.mutate({ switchAccountsAtLimit: next })}
      />
      <Failure error={set.error} />
    </div>
  );
}

/** Whether OpenOrc Cloud has a section in Settings > Cloud, so the person's own cloud service is named apart from it only when both show. */
export function useOpenOrcCloudShown(active: boolean): boolean {
  return proAccount(useRpc("account.status", {}, { enabled: active }).data) !== null;
}
