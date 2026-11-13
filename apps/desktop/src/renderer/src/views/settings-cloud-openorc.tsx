import { Select } from "../components/ui";
import { useRpc, useRpcMutation } from "../lib/client";
import { Failure } from "./settings-secret-field";
import { Field, Section } from "./settings-shared";

/**
 * Where a Pro person's threads on OpenOrc Cloud run: one of the sandbox services the server runs threads on, named as
 * it names them. Shown only when there is a choice to make; the server's answer is the state.
 */
export function OpenOrcCloudSection({ active }: { active: boolean }) {
  const account = useRpc("account.status", {}, { enabled: active }).data;
  const choose = useRpcMutation("account.setSandbox");
  if (account?.state !== "signed-in" || !account.plan.pro || !account.sandbox || account.sandbox.services.length < 2) return null;
  const { sandbox } = account;
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
