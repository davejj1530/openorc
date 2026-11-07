import { AGENT37_SIZES, type CloudService, type CloudStatus } from "@openorc/protocol";
import { Button, Select, TextButton } from "../components/ui";
import { useRpcMutation } from "../lib/client";
import { Field, Section, SettingRow, Status } from "./settings-shared";
import { Failure, TokenField } from "./settings-secret-field";

const KEYS_URL = "https://www.agent37.com";

const sizeLabel = ({ cpu, memory }: { cpu: number; memory: number }) => `${cpu} vCPUs · ${memory} GB`;

function Agent37Connected({ agent37 }: { agent37: NonNullable<CloudStatus["agent37"]> }) {
  const size = useRpcMutation("cloud.agent37.size");
  const disconnect = useRpcMutation("cloud.agent37.disconnect");
  const busy = size.isPending || disconnect.isPending;
  const chosen = AGENT37_SIZES.findIndex((option) => option.cpu === agent37.size.cpu && option.memory === agent37.size.memory);
  return (
    <>
      <Field label="Instance size" hint="New cloud threads get an instance this size.">
        <Select value={String(chosen)} disabled={busy} onChange={(e) => size.mutate({ size: AGENT37_SIZES[Number(e.target.value)]! })}>
          {AGENT37_SIZES.map((option, index) => (
            <option key={sizeLabel(option)} value={index}>
              {sizeLabel(option)}
            </option>
          ))}
        </Select>
      </Field>
      <SettingRow label="Account">
        <Status ok>Connected</Status>
        <Button variant="ghost" disabled={busy} onClick={() => disconnect.mutate({})}>
          Disconnect
        </Button>
      </SettingRow>
      <Failure error={size.error ?? disconnect.error} />
    </>
  );
}

/** Agent37's key, kept in protected storage like Vercel's token. */
export function Agent37Settings({ status }: { status: CloudStatus }) {
  const connect = useRpcMutation("cloud.agent37.connect");
  return (
    <Section title="Agent37" description="Cloud threads can run in Agent37 instances, on your account.">
      {status.agent37 ? (
        <Agent37Connected agent37={status.agent37} />
      ) : (
        <>
          <TokenField
            label="API key"
            hint={
              <>
                Create one in{" "}
                <TextButton underline onClick={() => window.openorc.openExternal(KEYS_URL)}>
                  your Agent37 workspace
                </TextButton>
                .
              </>
            }
            action="Connect"
            placeholder="Paste key"
            busy={connect.isPending}
            onSave={(key) => connect.mutate({ key })}
          />
          <Failure error={connect.error} />
        </>
      )}
    </Section>
  );
}

const serviceNames: Record<CloudService, string> = { vercel: "Vercel", agent37: "Agent37" };

/** With both services connected, the one new cloud threads run on. A thread keeps the service it started on. */
export function CloudServiceChoice({ status }: { status: CloudStatus }) {
  const choose = useRpcMutation("cloud.service");
  if (!status.vercel?.team || !status.agent37 || !status.service) return null;
  const value = choose.isPending && choose.variables ? choose.variables.service : status.service;
  return (
    <Section title="New cloud threads">
      <Field label="Run on" hint="Threads already in the cloud stay where they are.">
        <Select value={value} disabled={choose.isPending} onChange={(e) => choose.mutate({ service: e.target.value as CloudService })}>
          {(Object.keys(serviceNames) as CloudService[]).map((service) => (
            <option key={service} value={service}>
              {serviceNames[service]}
            </option>
          ))}
        </Select>
      </Field>
      <Failure error={choose.error} />
    </Section>
  );
}
