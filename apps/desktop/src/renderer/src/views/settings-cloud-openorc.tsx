import { Select } from "../components/ui";
import type { AccountSandbox, AccountStatus } from "@openorc/protocol";
import { useRpc, useRpcMutation } from "../lib/client";
import { Failure } from "./settings-secret-field";
import { Field, Section } from "./settings-shared";

/**
 * Where a Pro person's threads on OpenOrc Cloud run: one of the sandbox services the server runs threads on, named as
 * it names them. Shown only when there is a choice to make; the server's answer is the state.
 */
export function OpenOrcCloudSection({ active }: { active: boolean }) {
  const choose = useRpcMutation("account.setSandbox");
  const sandbox = sandboxChoice(useRpc("account.status", {}, { enabled: active }).data);
  if (!sandbox) return null;
  return (
    <Section title="OpenOrc Cloud">
      <Field label="Threads run on">
        <Select value={sandbox.chosen ?? sandbox.fallback} disabled={choose.isPending} onChange={(e) => choose.mutate({ service: e.target.value })}>
          {sandbox.services.map((service) => (
            <option key={service.id} value={service.id}>
              {service.name}
            </option>
          ))}
        </Select>
      </Field>
      <Failure error={choose.error} />
    </Section>
  );
}

/** The sandbox choice a Pro person has, or null when there is none to make. */
function sandboxChoice(account: AccountStatus | undefined): AccountSandbox | null {
  if (account?.state !== "signed-in" || !account.plan.pro || !account.sandbox || account.sandbox.services.length < 2) return null;
  return account.sandbox;
}

/** Whether OpenOrc Cloud has a section in Settings > Cloud, so the person's own cloud service is named apart from it only when both show. */
export function useOpenOrcCloudShown(active: boolean): boolean {
  return sandboxChoice(useRpc("account.status", {}, { enabled: active }).data) !== null;
}
