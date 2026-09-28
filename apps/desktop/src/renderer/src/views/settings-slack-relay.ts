import { useState } from "react";
import type { SlackClientConfig } from "@openorc/protocol";
import { useRpc, useRpcMutation } from "../lib/query";
import { core } from "../lib/rpc";

/** Owns the relay forms and the save/connect/refetch lifecycle behind each action. */
export function useSlackRelaySettings(active: boolean) {
  const status = useRpc("slack.status", {}, { enabled: active, refetchInterval: active ? 2000 : false });
  const home = useRpc("workspace.get", {}, { enabled: active });
  const configure = useRpcMutation("workspace.configure");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [port, setPort] = useState<string>();
  const [userId, setUserId] = useState("");
  const [deviceLabel, setDeviceLabel] = useState("");
  const [issuedKey, setIssuedKey] = useState<string | null>(null);
  const [deviceKey, setDeviceKey] = useState("");
  const [draft, setDraft] = useState<Partial<SlackClientConfig>>({});
  const host = status.data?.host;
  const client = status.data?.client;
  const config: SlackClientConfig = { relayUrl: "http://127.0.0.1:47831", projectId: "", agent: "codex", permissionMode: "review", ...client?.config, ...draft };
  const disabled = busy || !status.data;

  async function act(operation: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await operation();
      setNotice(success);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update Slack settings.");
    } finally {
      try {
        await status.refetch();
      } finally {
        setBusy(false);
      }
    }
  }

  const chooseEntrypoint = async () => {
    const entrypoint = await window.openorc.pickDirectory();
    if (!entrypoint) return;
    try {
      await configure.mutateAsync({ entrypoint });
    } catch {
      /* The workspace configuration error is rendered beside this control. */
    }
  };
  const connectClient = () =>
    act(async () => {
      await core.call("slack.client.save", { ...config, ...(deviceKey.trim() ? { deviceKey: deviceKey.trim() } : {}) });
      setDeviceKey("");
      await core.call("slack.client.connect", {});
    }, "This computer is connected. Mention your OpenOrc bot in a channel where you've added it.");
  const disconnectClient = () => act(() => core.call("slack.client.disconnect", {}), "Desktop disconnected. Any running agent remains visible in OpenOrc.");
  const retryClient = () => act(() => core.call("slack.client.connect", {}), "Desktop connection checked and pending delivery retried.");
  const connectHost = () =>
    act(async () => {
      await core.call("slack.host.save", {
        ...(botToken.trim() ? { botToken: botToken.trim() } : {}),
        ...(appToken.trim() ? { appToken: appToken.trim() } : {}),
        channelId: host?.channelId ?? "",
        port: Number(port ?? host?.port ?? 47831),
      });
      setBotToken("");
      setAppToken("");
      await core.call("slack.host.connect", {});
    }, "Relay connected to Slack. Register your teammates below.");
  const disconnectHost = () => act(() => core.call("slack.host.disconnect", {}), "Relay disconnected. Teammates cannot send requests until you reconnect it.");
  const removeDevice = (id: string) => act(() => core.call("slack.device.remove", { id }), "Device removed. Its key no longer works.");
  const registerDevice = () =>
    act(async () => {
      const result = await core.call("slack.device.add", { userId: userId.trim(), label: deviceLabel.trim() });
      setIssuedKey(result.deviceKey);
      setUserId("");
      setDeviceLabel("");
    }, "Device registered. Copy its key before dismissing it.");
  const copyKey = () => issuedKey && act(() => navigator.clipboard.writeText(issuedKey), "Device key copied.");

  return {
    status,
    home,
    configure,
    host,
    client,
    config,
    disabled,
    busy,
    error,
    notice,
    fields: {
      botToken,
      setBotToken,
      appToken,
      setAppToken,
      port,
      setPort,
      userId,
      setUserId,
      deviceLabel,
      setDeviceLabel,
      issuedKey,
      dismissKey: () => setIssuedKey(null),
      deviceKey,
      setDeviceKey,
      updateConfig: (patch: Partial<SlackClientConfig>) => setDraft((current) => ({ ...current, ...patch })),
    },
    actions: { chooseEntrypoint, connectClient, disconnectClient, retryClient, connectHost, disconnectHost, removeDevice, registerDevice, copyKey },
  };
}
