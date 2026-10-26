import { useState, type ReactNode } from "react";
import type { Device, DeviceStatus } from "@openorc/protocol";
import { bootDevice, shutdownDevice, useDeviceOperations } from "../../lib/device/operations";
import { screenPhase, streamable, type ScreenPhase } from "../../lib/device/screen-phase";
import type { DeviceButton, DeviceTransport } from "../../lib/device/stream";
import { useDeviceStream } from "../../lib/device/use-device-stream";
import { useRpc } from "../../lib/client";
import { ChevronLeft, Home, Power, RotateCcw, Square } from "../icons";
import { PanelBar, PanelBarMeta, PanelNotice } from "../PanelBar";
import { IconButton, Tooltip } from "../ui";
import { DeviceLoadError } from "./DeviceLoadError";
import { DeviceStage } from "./DeviceStage";
import "./device.css";

const hardware: Record<Device["platform"], Array<{ button: DeviceButton; label: string; Icon: typeof Home }>> = {
  ios: [
    { button: "home", label: "Home", Icon: Home },
    { button: "rotate", label: "Rotate", Icon: RotateCcw },
  ],
  android: [
    { button: "back", label: "Back", Icon: ChevronLeft },
    { button: "home", label: "Home", Icon: Home },
    { button: "recents", label: "Recents", Icon: Square },
  ],
};

function ToolbarButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip label={label}>
      <IconButton aria-label={label} disabled={disabled} onClick={onClick}>
        {children}
      </IconButton>
    </Tooltip>
  );
}

function DeviceToolbar({ device, phase, transport, input }: { device: Device; phase: ScreenPhase; transport: DeviceTransport | null; input: boolean }) {
  const live = transport !== null && input && (phase.kind === "streaming" || phase.kind === "reconnecting");
  const running = device.state === "booted" || device.state === "booting";
  return (
    <PanelBar title={device.name} meta={<PanelBarMeta>{device.os}</PanelBarMeta>}>
      {running ? (
        <>
          {hardware[device.platform].map(({ button, label, Icon }) => (
            <ToolbarButton key={button} label={label} disabled={!live} onClick={() => transport?.press(button)}>
              <Icon size={15} />
            </ToolbarButton>
          ))}
          <ToolbarButton label="Shut down" disabled={phase.kind === "stopping"} onClick={() => void shutdownDevice(device.id)}>
            <Power size={15} />
          </ToolbarButton>
        </>
      ) : null}
    </PanelBar>
  );
}

/** One device's live screen: the toolbar, then the screen in whatever state the device and its stream are in. */
export function DeviceScreen({ deviceId, name, status }: { deviceId: string; name: string; status: DeviceStatus }) {
  const list = useRpc("devices.list", {});
  const device = list.data?.devices.find((candidate) => candidate.id === deviceId);
  const operation = useDeviceOperations((s) => s.operations[deviceId]);
  const support = status.platforms.find((platform) => platform.platform === device?.platform);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const live = device !== undefined && streamable({ device, operation, support });
  const { view, transport } = useDeviceStream(device?.platform ?? "ios", live ? deviceId : null, canvas);
  if (list.isError) return <DeviceLoadError message="Could not list devices." retry={() => void list.refetch()} />;
  if (!list.data) return null;
  const phase = screenPhase({ device, operation, support, stream: view.status });
  if (!device)
    return (
      <div className="device-screen">
        <PanelBar title={name} />
        <PanelNotice>{phase.kind === "unavailable" ? phase.reason : null}</PanelNotice>
      </div>
    );
  return (
    <div className="device-screen">
      <DeviceToolbar device={device} phase={phase} transport={transport} input={view.input} />
      {operation?.kind === "failed" ? (
        <PanelNotice tone="bad" role="alert">
          {operation.error}
        </PanelNotice>
      ) : null}
      <DeviceStage device={device} phase={phase} view={view} transport={transport} canvasRef={setCanvas} onStart={() => void bootDevice(device.id)} />
    </div>
  );
}
