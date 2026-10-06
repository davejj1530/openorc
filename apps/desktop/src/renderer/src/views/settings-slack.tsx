import { relayClientStatus, relayHostStatus } from "./settings-presentation";
import { useState } from "react";
import {
  harnessCatalog,
  harnessIds,
  ExecutionMode,
  executionMode,
  executionModeAvailable,
  executionModeNote,
  executionModeSettings,
  executionModePresentation,
  type SlackClientConfig,
} from "@openorc/protocol";
import { Badge, Button, Input, Select } from "../components/ui";
import { useRpc } from "../lib/query";
import { Field, LoadError, Section } from "./settings-shared";
import { DirectSlackSettings } from "./settings-slack-direct";
import { useSlackRelaySettings } from "./settings-slack-relay";

export function SlackSettings({ active }: { active: boolean }) {
  const status = useRpc("slack.status", {}, { enabled: active, refetchInterval: active ? 2000 : false });
  const [choice, setChoice] = useState<"direct" | "relay" | null>(null);
  const mode = choice ?? status.data?.mode ?? "direct";
  const connected = status.data?.direct.enabled || status.data?.direct.busy || status.data?.host.enabled || status.data?.client.enabled || status.data?.client.busy;
  return (
    <>
      <Section title="Connection type">
        <Field label="Connect Slack" hint={connected ? "Disconnect and finish pending work before changing connection type." : "Use a personal bot for this computer, or an existing team relay."}>
          <Select value={mode} disabled={!status.data || connected} onChange={(e) => setChoice(e.target.value as "direct" | "relay")}>
            <option value="direct">Personal bot · no server needed</option>
            <option value="relay">Team relay · advanced</option>
          </Select>
        </Field>
      </Section>
      <div hidden={mode !== "direct"}>
        <DirectSlackSettings active={active && mode === "direct"} />
      </div>
      <div hidden={mode !== "relay"}>
        <RelaySlackSettings active={active && mode === "relay"} />
      </div>
    </>
  );
}

function RelaySlackSettings({ active }: { active: boolean }) {
  const { status, home, configure, host, client, config, disabled, busy, error, notice, fields, actions } = useSlackRelaySettings(active);
  const { botToken, setBotToken, appToken, setAppToken, port, setPort, userId, setUserId, deviceLabel, setDeviceLabel, issuedKey, dismissKey, deviceKey, setDeviceKey, updateConfig } = fields;

  return (
    <>
      <p className="text-ink-2 mb-4">
        Mention your OpenOrc bot in any channel where you've added it. Name a project or folder and, optionally, a model: “Read my-app using Astra.” Replies are visible to everyone in that channel.
      </p>
      {status.isError && <LoadError retry={() => void status.refetch()} />}
      <Section title="This computer" description="Get a device key from the person hosting the relay. It connects only your Slack user to this computer.">
        <div className="flex items-center justify-between gap-3 mb-3">
          <span>{client?.userId ? `Slack user ${client.userId}` : "Desktop connection"}</span>
          <Badge tone={client?.connected && !client.error ? "ok" : "muted"}>{relayClientStatus(client)}</Badge>
        </div>
        <Field label="Relay address" hint="On another machine, use the local address of your SSH tunnel.">
          <Input value={config.relayUrl} disabled={disabled || client?.enabled || client?.busy} onChange={(e) => updateConfig({ relayUrl: e.target.value })} />
        </Field>
        <Field label="Device key" hint={client?.configured ? "Saved securely. Leave blank to keep it." : "Unique to your registered desktop."}>
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={deviceKey}
            disabled={disabled || client?.enabled || client?.busy}
            onChange={(e) => setDeviceKey(e.target.value)}
            placeholder={client?.configured ? "Saved device key" : "oqd_…"}
          />
        </Field>
        <Field label="Workspace entrypoint" hint="Slack conversations live in Workspace. Requests can select imported projects or folders beneath this entrypoint; follow-ups remember their folder.">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm text-ink-2 truncate flex-1" title={home.data?.rootPath}>
              {home.data?.rootPath ?? "Loading folder…"}
            </span>
            <Button size="sm" disabled={disabled || configure.isPending || client?.busy} onClick={() => void actions.chooseEntrypoint()}>
              Choose folder
            </Button>
          </div>
          {configure.error ? (
            <p role="alert" className="text-xs text-bad">
              {configure.error.message}
            </p>
          ) : null}
        </Field>
        <Field label="Default coding agent">
          <Select value={config.agent} disabled={disabled || client?.enabled || client?.busy} onChange={(e) => updateConfig({ agent: e.target.value as SlackClientConfig["agent"] })}>
            {harnessIds.map((id) => (
              <option key={id} value={id}>
                {harnessCatalog[id].name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Default model" hint="Say “using Astra” or another available model in Slack to change it for that thread. Leave blank for the agent's default.">
          <Input value={config.model ?? ""} disabled={disabled || client?.enabled || client?.busy} onChange={(e) => updateConfig({ model: e.target.value })} placeholder="Agent default" />
        </Field>
        <Field label="Mode" hint="Applies to every Slack turn. A stricter conversation mode is always respected.">
          <Select
            disabled={disabled || client?.enabled || client?.busy}
            value={executionMode(config.mode ?? "act", config.permissionMode)}
            onChange={(e) => updateConfig(executionModeSettings(e.target.value as ExecutionMode))}
          >
            {ExecutionMode.options.map((value) => (
              <option key={value} value={value} hidden={!executionModeAvailable(config.agent, value)}>
                {executionModePresentation(config.agent, value).label}
              </option>
            ))}
          </Select>
          <p className="mt-2 text-xs text-ink-3">{executionModeNote(config.agent, executionMode(config.mode ?? "act", config.permissionMode))}</p>
        </Field>
        {client?.error && (
          <p className="text-bad mt-3" role="status">
            {client.error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2 mt-4">
          {client?.configured && (
            <Button disabled={disabled} onClick={() => void actions.disconnectClient()}>
              Disconnect desktop
            </Button>
          )}
          <Button variant="primary" disabled={disabled || client?.enabled || client?.busy || (!deviceKey && !client?.configured)} onClick={() => void actions.connectClient()}>
            Connect this computer
          </Button>
          {client?.busy && (!client.connected || client.error) && (
            <Button disabled={disabled} onClick={() => void actions.retryClient()}>
              {client.connected ? "Retry Slack delivery" : "Reconnect to send result"}
            </Button>
          )}
        </div>
      </Section>
      <details className="mt-6">
        <summary className="text-lg font-semibold py-2">Host the Slack connection</summary>
        <Section title="Slack connection" description="Set this up once on the host computer. Keep OpenOrc open and the computer awake. Teammates use device keys instead of these tokens.">
          <div className="flex justify-between gap-3 mb-3">
            <span>{host?.workspace ?? "Slack workspace"}</span>
            <Badge tone={host?.connected ? "ok" : "muted"}>{relayHostStatus(host)}</Badge>
          </div>
          <Field label="Bot token" hint={host?.configured ? "Saved securely. Leave blank to keep it." : "From OAuth & Permissions in your Slack app."}>
            <Input type="password" autoComplete="off" spellCheck={false} placeholder="xoxb-…" value={botToken} disabled={disabled || host?.enabled} onChange={(e) => setBotToken(e.target.value)} />
          </Field>
          <Field label="App token" hint="App-level token with connections:write.">
            <Input type="password" autoComplete="off" spellCheck={false} placeholder="xapp-…" value={appToken} disabled={disabled || host?.enabled} onChange={(e) => setAppToken(e.target.value)} />
          </Field>
          <Field label="Local relay port" hint="Listens only on 127.0.0.1. Use SSH forwarding for a teammate's machine.">
            <Input type="number" min={1024} max={65535} value={port ?? String(host?.port ?? 47831)} disabled={disabled || host?.enabled} onChange={(e) => setPort(e.target.value)} />
          </Field>
          {host?.error && (
            <p className="text-bad mt-3" role="status">
              {host.error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2 mt-4">
            <Button disabled={disabled} onClick={() => void actions.disconnectHost()}>
              Disconnect relay
            </Button>
            <Button disabled={disabled || host?.enabled} onClick={() => void actions.connectHost()}>
              Save and connect relay
            </Button>
          </div>
        </Section>
        <Section title="Teammates" description="Register each teammate's Slack member ID. Give the generated key only to that person, through a private channel.">
          {status.data?.devices.map((device) => (
            <div className="settings-field" key={device.id}>
              <div>
                <span className="font-medium">{device.label}</span>
                <span className="block text-sm text-ink-2">
                  {device.userId} · {device.online ? "Online" : "Offline"}
                </span>
              </div>
              <Button disabled={disabled} onClick={() => void actions.removeDevice(device.id)}>
                Remove
              </Button>
            </div>
          ))}
          <Field label="Slack member ID">
            <Input value={userId} placeholder="U0123456789" onChange={(e) => setUserId(e.target.value)} disabled={disabled} />
          </Field>
          <Field label="Device label">
            <Input value={deviceLabel} placeholder="Alice's Mac" onChange={(e) => setDeviceLabel(e.target.value)} disabled={disabled} />
          </Field>
          <div className="flex justify-end mt-3">
            <Button disabled={disabled || !host?.connected || !userId.trim() || !deviceLabel.trim()} onClick={() => void actions.registerDevice()}>
              Register device
            </Button>
          </div>
          {issuedKey && (
            <div className="mt-4">
              <Field label="New device key" hint="Shown once. Paste into This computer or share privately with its owner.">
                <Input type="password" readOnly value={issuedKey} />
              </Field>
              <div className="flex justify-end gap-2 mt-2">
                <Button onClick={() => void actions.copyKey()}>Copy key</Button>
                <Button onClick={dismissKey}>Dismiss key</Button>
              </div>
            </div>
          )}
        </Section>
      </details>
      <div aria-live="polite" className="settings-feedback">
        {relayFeedback({ error, busy, connectionError: Boolean(client?.error || host?.error), notice })}
      </div>
    </>
  );
}

function relayFeedback({ error, busy, connectionError, notice }: { error: string | null; busy: boolean; connectionError: boolean; notice: string | null }) {
  if (error) {
    return (
      <span role="alert" className="text-bad">
        {error}
      </span>
    );
  }
  if (busy) {
    return "Updating Slack connection…";
  }
  if (connectionError) {
    return "Resolve the error above, then retry.";
  }
  return notice ?? "Connections start when you choose Connect.";
}
