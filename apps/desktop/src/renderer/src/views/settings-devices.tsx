import type { DeviceHelpers, DeviceSettings as DeviceSettingsValue, DeviceTool } from "@openorc/protocol";
import { helpersBusy, helpersProgress } from "../lib/device/setup";
import { queryClient, useRpc, useRpcMutation } from "../lib/client";
import { LoadError, SaveStatus, Section, Toggle } from "./settings-shared";

function toolVersion(tool: DeviceTool): string {
  if (!tool.installed) return "not installed";
  return tool.installed === tool.pinned ? tool.installed : `${tool.installed}, updates to ${tool.pinned}`;
}

function saveState(save: { isPending: boolean; isError: boolean; isSuccess: boolean }): "saving" | "error" | "saved" | "idle" {
  if (save.isPending) return "saving";
  if (save.isError) return "error";
  return save.isSuccess ? "saved" : "idle";
}

/** What the helpers are doing while they install or start, or why they stopped. */
function HelpersNote({ helpers }: { helpers: DeviceHelpers }) {
  const progress = helpersProgress(helpers);
  if (progress)
    return (
      <p role="status" className="settings-note">
        {progress}
      </p>
    );
  return helpers.phase === "failed" ? (
    <p role="alert" className="settings-note text-bad">
      {helpers.error}
    </p>
  ) : null;
}

function ToolVersions({ tools }: { tools: DeviceTool[] }) {
  if (tools.length === 0) return null;
  return (
    <details className="settings-agent-location">
      <summary>Installed tools</summary>
      {tools.map((tool) => (
        <code key={tool.name}>
          {tool.name} {toolVersion(tool)}
        </code>
      ))}
    </details>
  );
}

/** Device support and agent access, saved by the core. Turning support on installs and starts the helpers. */
export function DeviceSettings({ active }: { active: boolean }) {
  const save = useRpcMutation("devices.settings.set");
  // Turning support on resolves only once the helpers run; reading status meanwhile shows the install.
  const status = useRpc("devices.status", {}, { enabled: active, refetchInterval: (query) => (save.isPending || helpersBusy(query.state.data?.helpers) ? 1_000 : false) });
  const data = status.data;
  const value: Partial<DeviceSettingsValue> = { ...data?.settings, ...(save.isPending ? save.variables : null) };
  const commit = (patch: Partial<DeviceSettingsValue>) =>
    save.mutate(patch, {
      onSuccess: (result) => queryClient.setQueryData(["devices.status", {}], result),
    });
  const blocked = value.enabled ? null : (data?.blocked ?? null);
  const retry = () => {
    if (save.variables) commit(save.variables);
  };
  return (
    <>
      {status.isError && <LoadError retry={() => void status.refetch()} />}
      <Section title="Access">
        <Toggle
          label="Device support"
          hint={blocked ?? undefined}
          checked={value.enabled ?? false}
          disabled={!data || save.isPending || blocked !== null}
          onChange={(enabled) => commit({ enabled })}
        />
        <Toggle label="Agents can use devices" checked={value.agentAccess ?? true} disabled={!data || save.isPending} onChange={(agentAccess) => commit({ agentAccess })} />
        {data ? <HelpersNote helpers={data.helpers} /> : null}
        <ToolVersions tools={data?.tools ?? []} />
      </Section>
      <SaveStatus status={saveState(save)} retry={retry} />
    </>
  );
}
