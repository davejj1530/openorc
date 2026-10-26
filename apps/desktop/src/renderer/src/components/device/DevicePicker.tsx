import type { Device, DeviceStatus } from "@openorc/protocol";
import { bootDevice, shutdownDevice, useDeviceOperations } from "../../lib/device/operations";
import { blockedPlatforms, groupDevices, rowAction, rowState, type RowState } from "../../lib/device/picker";
import { useRpc, useRpcMutation } from "../../lib/client";
import { Button, StatusDot, TextButton, Tooltip } from "../ui";
import { DeviceGlyph } from "./DeviceGlyph";
import { DeviceLoadError } from "./DeviceLoadError";
import "./device.css";

function DeviceState({ state }: { state: RowState }) {
  const word = (
    <span className="device-state">
      <StatusDot tone={state.tone} />
      {state.word}
    </span>
  );
  return state.detail ? <Tooltip label={state.detail}>{word}</Tooltip> : word;
}

const actionLabel = { start: "Start", "shut down": "Shut down" } as const;

function DeviceRow({ device, onOpen }: { device: Device; onOpen: (device: Device) => void }) {
  const operation = useDeviceOperations((s) => s.operations[device.id]);
  const state = rowState(device, operation);
  const action = rowAction(device, operation);
  return (
    <div className="device-row">
      <button type="button" className="device-row-open" onClick={() => onOpen(device)}>
        <DeviceGlyph formFactor={device.formFactor} />
        <span className="device-row-name">{device.name}</span>
        {state ? <DeviceState state={state} /> : null}
      </button>
      {action ? (
        <Button
          size="sm"
          className="device-row-action"
          aria-label={`${actionLabel[action]} ${device.name}`}
          onClick={() => void (action === "start" ? bootDevice(device.id) : shutdownDevice(device.id))}
        >
          {actionLabel[action]}
        </Button>
      ) : null}
    </div>
  );
}

/** The helpers stopped and will not come back on their own. */
function HelpersFailure({ status }: { status: DeviceStatus }) {
  const setup = useRpcMutation("devices.setup");
  if (status.helpers.phase !== "failed") return null;
  return (
    <div role="alert" className="device-notes mb-4" data-tone="bad">
      <p>
        {status.helpers.error}{" "}
        <TextButton underline disabled={setup.isPending} onClick={() => setup.mutate({ agentAccess: status.settings.agentAccess })}>
          Try again
        </TextButton>
      </p>
    </div>
  );
}

/** Every simulator and emulator on this Mac, grouped by OS version. Choosing one opens it in this tab. */
export function DevicePicker({ status, onOpen }: { status: DeviceStatus; onOpen: (device: Device) => void }) {
  const list = useRpc("devices.list", {});
  if (list.isError) return <DeviceLoadError message="Could not list devices." retry={() => void list.refetch()} />;
  if (!list.data) return null;
  const groups = groupDevices(list.data.devices);
  const notes = [...blockedPlatforms(status.platforms).map((blocked) => blocked.reason), ...list.data.warnings];
  return (
    <div className="device-page">
      <HelpersFailure status={status} />
      {groups.map((group) => (
        <section key={`${group.platform}:${group.os}`} className="device-group" aria-label={group.os}>
          <h2>{group.os}</h2>
          <div className="device-rows">
            {group.devices.map((device) => (
              <DeviceRow key={device.id} device={device} onOpen={onOpen} />
            ))}
          </div>
        </section>
      ))}
      {groups.length === 0 || notes.length > 0 ? (
        <div className="device-notes">
          {groups.length === 0 ? <p>No simulators or emulators on this Mac.</p> : null}
          {notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
