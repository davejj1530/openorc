import { HOSTED_AGENTS, type AccountStatus } from "@openorc/protocol";
import { Select } from "../components/ui";
import { useRpc, useRpcMutation } from "../lib/client";
import { Failure } from "./settings-secret-field";
import { GithubRow } from "./settings-cloud-openorc-projects";
import { AgentSignInRow } from "./settings-cloud-openorc-sign-ins";
import { Field, Section } from "./settings-shared";

type ProAccount = Extract<AccountStatus, { state: "signed-in" }>;

/** OpenOrc Cloud's part of Settings > Cloud: shown to a Pro person, whom it runs threads for. */
function proAccount(account: AccountStatus | undefined): ProAccount | null {
  return account?.state === "signed-in" && account.plan.pro ? account : null;
}

/**
 * OpenOrc Cloud for a Pro person: where their threads run, when the server runs them in more than one place, each
 * agent's sign-in there with the ways to sign it in, and their GitHub. The server's answers
 * are the state.
 */
export function OpenOrcCloudSection({ active }: { active: boolean }) {
  const choose = useRpcMutation("account.setSandbox");
  const account = proAccount(useRpc("account.status", {}, { enabled: active }).data);
  if (!account) return null;
  const { sandbox } = account;
  return (
    <Section title="OpenOrc Cloud">
      {sandbox && sandbox.services.length > 1 ? (
        <Field label="Threads run on">
          <Select value={sandbox.chosen ?? sandbox.fallback} disabled={choose.isPending} onChange={(e) => choose.mutate({ service: e.target.value })}>
            {sandbox.services.map((service) => (
              <option key={service.id} value={service.id}>
                {service.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {account.signIns ? HOSTED_AGENTS.map((agent) => <AgentSignInRow key={agent} agent={agent} rows={account.signIns!.filter((row) => row.agent === agent)} work={account.signingIn[agent]} />) : null}
      <GithubRow account={account} />
      <Failure error={choose.error} />
    </Section>
  );
}

/** Whether OpenOrc Cloud has a section in Settings > Cloud, so the person's own cloud service is named apart from it only when both show. */
export function useOpenOrcCloudShown(active: boolean): boolean {
  return proAccount(useRpc("account.status", {}, { enabled: active }).data) !== null;
}
