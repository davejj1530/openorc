import { useState } from "react";
import type { DevicePlatformSupport, DeviceStatus } from "@openorc/protocol";
import { consentLine, helpersProgress, platformNote, setupBlocked, toolsToInstall } from "../../lib/device/setup";
import { useRpc, useRpcMutation } from "../../lib/client";
import { Button, StatusDot, Switch, Tooltip } from "../ui";
import { platformName } from "./DeviceGlyph";
import "./device.css";

function PlatformRow({ support }: { support: DevicePlatformSupport }) {
  const note = platformNote(support);
  return (
    <div className="device-setup-row">
      <span>
        <span>{platformName[support.platform]}</span>
        {note ? <span className="device-setup-reason">{note}</span> : null}
      </span>
      <span className="device-state">
        <StatusDot tone={support.available ? "ok" : "muted"} />
        {support.available ? "Available" : "Unavailable"}
      </span>
    </div>
  );
}

/** First run inside the tab: what this Mac can run, whether agents may use devices, and one action. Opening it changes nothing. */
export function DeviceSetup({ status }: { status: DeviceStatus }) {
  const [agentAccess, setAgentAccess] = useState(status.settings.agentAccess);
  const setup = useRpcMutation("devices.setup");
  // The call resolves only when the helpers run; reading status meanwhile shows what they are doing.
  useRpc("devices.status", {}, { refetchInterval: setup.isPending ? 1_000 : false });
  const installing = toolsToInstall(status.tools, agentAccess).length > 0;
  const blocked = setupBlocked(status);
  const pending = installing ? "Installing" : "Starting";
  const progress = helpersProgress(status.helpers) ?? (setup.isPending ? pending : null);
  const failure = setup.error?.message ?? (status.helpers.phase === "failed" ? status.helpers.error : null);
  const consent = consentLine(status.tools, agentAccess);
  const action = (
    <Button variant="primary" size="lg" disabled={blocked !== null || progress !== null} onClick={() => setup.mutate({ agentAccess })}>
      {installing ? "Install and start" : "Start"}
    </Button>
  );
  return (
    <div className="device-page">
      <div className="device-setup motion-arrive">
        <h2 className="device-setup-title">Simulators and emulators</h2>
        <div className="device-setup-card" data-plane="tile">
          {status.platforms.map((support) => (
            <PlatformRow key={support.platform} support={support} />
          ))}
          <label className="device-setup-row">
            <span>Agents can use devices</span>
            <Switch checked={agentAccess} disabled={progress !== null} onChange={(event) => setAgentAccess(event.target.checked)} />
          </label>
        </div>
        {consent ? <p className="device-setup-consent">{consent}</p> : null}
        <div className="device-setup-actions">
          {blocked ? <Tooltip label={blocked}>{action}</Tooltip> : action}
          {progress ? (
            <span className="device-progress" role="status">
              <span className="reply-pulse" aria-hidden="true" />
              {progress}
            </span>
          ) : null}
        </div>
        {failure && !progress ? (
          <p role="alert" className="device-notes" data-tone="bad">
            {failure}
          </p>
        ) : null}
      </div>
    </div>
  );
}
