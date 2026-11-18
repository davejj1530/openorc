import { HOSTED_AGENTS, type AccountStatus } from "@openorc/protocol";
import { useRpc } from "../lib/client";
import { GithubRow } from "./settings-cloud-openorc-projects";
import { AgentSignInRow } from "./settings-cloud-openorc-sign-ins";
import { Section } from "./settings-shared";

type ProAccount = Extract<AccountStatus, { state: "signed-in" }>;

/** OpenOrc Cloud's part of Settings > Cloud: shown to a Pro person, whom it runs threads for. */
function proAccount(account: AccountStatus | undefined): ProAccount | null {
  return account?.state === "signed-in" && account.plan.pro ? account : null;
}

/** OpenOrc Cloud for a Pro person: each agent's sign-in there with the ways to sign it in, and their GitHub. The server's answers are the state. */
export function OpenOrcCloudSection({ active }: { active: boolean }) {
  const account = proAccount(useRpc("account.status", {}, { enabled: active }).data);
  if (!account) return null;
  return (
    <Section title="OpenOrc Cloud">
      {account.signIns ? HOSTED_AGENTS.map((agent) => <AgentSignInRow key={agent} agent={agent} rows={account.signIns!.filter((row) => row.agent === agent)} work={account.signingIn[agent]} />) : null}
      <GithubRow account={account} />
    </Section>
  );
}

/** Whether OpenOrc Cloud has a section in Settings > Cloud, so the person's own cloud service is named apart from it only when both show. */
export function useOpenOrcCloudShown(active: boolean): boolean {
  return proAccount(useRpc("account.status", {}, { enabled: active }).data) !== null;
}
