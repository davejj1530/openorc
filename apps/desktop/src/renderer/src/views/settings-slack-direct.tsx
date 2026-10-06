import { directSlackStatus } from "./settings-presentation";
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
  type SlackDirectConfig,
} from "@openorc/protocol";
import { Badge, Button, Input, Select } from "../components/ui";
import { useRpc, useRpcMutation } from "../lib/query";
import { core } from "../lib/rpc";
import { slackPersonalCreateUrl, slackPersonalManifest } from "../lib/slack-setup";
import { Field, LoadError, Section } from "./settings-shared";

export function DirectSlackSettings({ active }: { active: boolean }) {
  const status = useRpc("slack.status", {}, { enabled: active, refetchInterval: active ? 2000 : false });
  const home = useRpc("workspace.get", {}, { enabled: active });
  const configure = useRpcMutation("workspace.configure");
  const [draft, setDraft] = useState<Partial<SlackDirectConfig>>({});
  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [appName, setAppName] = useState("OpenOrc Personal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const direct = status.data?.direct;
  const config: SlackDirectConfig = { userId: "", agent: "codex", permissionMode: "review", ...direct?.config, ...draft };
  const disabled = busy || !status.data;
  const locked = disabled || direct?.enabled || direct?.busy;
  async function act(operation: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    let failure: string | null = null;
    try {
      await operation();
      setNotice(success);
    } catch (e) {
      failure = e instanceof Error ? e.message : "Could not update your Slack connection.";
    } finally {
      const latest = await status.refetch();
      setError(failure === latest.data?.direct.error ? null : failure);
      setBusy(false);
    }
  }
  return (
    <>
      <p className="text-ink-2 mb-4">Connect your own Slack bot to this computer. Each teammate creates a separate bot. Keep OpenOrc open and your computer awake to receive requests.</p>
      {status.isError && <LoadError retry={() => void status.refetch()} />}
      <details open={!direct?.configured} className="mb-6">
        <summary className="text-lg font-semibold py-2">Set up your Slack app</summary>
        <ol className="list-decimal pl-5 space-y-5 mt-3 text-md">
          <li>
            <p className="font-medium">Create a personal app</p>
            <p className="text-ink-2 mt-1">
              Choose a distinct name, such as OpenOrc Personal. Open the setup link, choose your workspace, review the prefilled settings, and create the app. Your workspace may require admin
              approval.
            </p>
            <div className="flex flex-wrap items-end gap-2 mt-3">
              <label className="flex-1 min-w-0">
                App name
                <Input aria-label="App name" maxLength={35} value={appName} onChange={(e) => setAppName(e.target.value)} />
              </label>
              <Button onClick={() => window.openorc.openExternal(slackPersonalCreateUrl(appName))}>Create Slack app</Button>
              <Button
                onClick={() =>
                  void act(
                    () => navigator.clipboard.writeText(JSON.stringify(slackPersonalManifest(appName), null, 2)),
                    "Manifest copied. In Slack, choose Create New App → From a manifest, then paste it as JSON.",
                  )
                }
              >
                Copy manifest
              </Button>
            </div>
            <p className="text-sm text-ink-2 mt-2">
              The template enables Socket Mode, approval buttons, channel/thread events, and image attachments. If the link does not prefill the form, use Copy manifest.
            </p>
            <p className="text-sm text-ink-2 mt-2">
              Already connected? To receive images, add the files:read bot scope under OAuth &amp; Permissions in your Slack app, then reinstall it to your workspace.
            </p>
          </li>
          <li>
            <p className="font-medium">Install the app and copy its bot token</p>
            <p className="text-ink-2 mt-1">In Slack’s app settings, open OAuth &amp; Permissions → Install to Workspace. Approve access, then copy the Bot User OAuth Token beginning with xoxb-.</p>
          </li>
          <li>
            <p className="font-medium">Generate an app token</p>
            <p className="text-ink-2 mt-1">
              Open Basic Information → App-Level Tokens → Generate Token and Scopes. Name it OpenOrc desktop, add connections:write, then copy the token beginning with xapp-. Use tokens from the same
              app.
            </p>
          </li>
          <li>
            <p className="font-medium">Copy your Slack member ID</p>
            <p className="text-ink-2 mt-1">In Slack, open your own profile → More → Copy member ID. Only requests and approvals from this member will control your computer.</p>
          </li>
        </ol>
        <Button className="mt-4" variant="ghost" onClick={() => window.openorc.openExternal("https://api.slack.com/apps")}>
          Open Slack app settings
        </Button>
      </details>
      <Section title="Personal connection" description="Tokens stay encrypted on this computer. Leave a saved token blank to keep it.">
        <div className="flex items-center justify-between gap-3 mb-3">
          <span>{direct?.workspace ? `${direct.ownerName ?? config.userId} · ${direct.workspace}` : "This computer"}</span>
          <Badge tone={direct?.connected && !direct.error ? "ok" : "muted"}>{directSlackStatus(direct)}</Badge>
        </div>
        <Field label="Bot token" hint="OAuth & Permissions → Bot User OAuth Token.">
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={botToken}
            disabled={locked}
            placeholder={direct?.configured ? "Saved bot token" : "xoxb-…"}
            onChange={(e) => setBotToken(e.target.value)}
          />
        </Field>
        <Field label="App token" hint="Basic Information → App-Level Tokens. Needs connections:write.">
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={appToken}
            disabled={locked}
            placeholder={direct?.configured ? "Saved app token" : "xapp-…"}
            onChange={(e) => setAppToken(e.target.value)}
          />
        </Field>
        <Field label="Your Slack member ID" hint="Use your own member ID from the workspace where you installed the bot.">
          <Input value={config.userId} disabled={locked} spellCheck={false} placeholder="U…" onChange={(e) => setDraft({ ...draft, userId: e.target.value.trim() })} />
        </Field>
        {direct?.error && (
          <p role="status" className="text-bad mt-3">
            {direct.error}
          </p>
        )}
      </Section>
      <Section
        title="Execution defaults"
        description="Model defaults apply to new conversations. The selected mode constrains every Slack turn, including existing threads. Disconnect Slack to change it."
      >
        <Field label="Workspace entrypoint" hint="Find projects inside this folder or among your imported projects.">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm text-ink-2 truncate flex-1" title={home.data?.rootPath}>
              {home.data?.rootPath ?? "Loading folder…"}
            </span>
            <Button
              size="sm"
              disabled={locked || configure.isPending}
              onClick={() =>
                void act(async () => {
                  const entrypoint = await window.openorc.pickDirectory();
                  if (entrypoint) await configure.mutateAsync({ entrypoint });
                }, "Workspace entrypoint checked.")
              }
            >
              Choose folder
            </Button>
          </div>
        </Field>
        <Field label="Default coding agent">
          <Select disabled={locked} value={config.agent} onChange={(e) => setDraft({ ...draft, agent: e.target.value as SlackDirectConfig["agent"] })}>
            {harnessIds.map((id) => (
              <option key={id} value={id}>
                {harnessCatalog[id].name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Default model" hint="Leave blank for the agent default. You can request a different model in Slack.">
          <Input disabled={locked} value={config.model ?? ""} placeholder="Agent default" onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
        </Field>
        <Field label="Mode" hint="Applies to every Slack turn. A stricter conversation mode is always respected.">
          <Select
            disabled={locked}
            value={executionMode(config.mode ?? "act", config.permissionMode)}
            onChange={(e) => setDraft({ ...draft, ...executionModeSettings(e.target.value as ExecutionMode) })}
          >
            {ExecutionMode.options.map((value) => (
              <option key={value} value={value} hidden={!executionModeAvailable(config.agent, value)}>
                {executionModePresentation(config.agent, value).label}
              </option>
            ))}
          </Select>
          <p className="mt-2 text-xs text-ink-3">{executionModeNote(config.agent, executionMode(config.mode ?? "act", config.permissionMode))}</p>
        </Field>
        <div className="flex flex-wrap justify-end gap-2 mt-4">
          {(direct?.enabled || direct?.busy) && (
            <Button disabled={disabled} onClick={() => void act(() => core.call("slack.direct.disconnect", {}), "Slack disconnected. Any running agent remains visible in OpenOrc.")}>
              Disconnect Slack
            </Button>
          )}
          {direct?.enabled || direct?.busy ? (
            <Button disabled={disabled} onClick={() => void act(() => core.call("slack.direct.connect", {}), "Connection checked and pending delivery retried.")}>
              Check connection
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={disabled || !/^[UW][A-Z0-9]+$/.test(config.userId) || (!direct?.configured && (!botToken.trim() || !appToken.trim()))}
              onClick={() =>
                void act(async () => {
                  await core.call("slack.direct.save", { ...config, ...(botToken.trim() ? { botToken: botToken.trim() } : {}), ...(appToken.trim() ? { appToken: appToken.trim() } : {}) });
                  setBotToken("");
                  setAppToken("");
                  setDraft({});
                  await core.call("slack.direct.connect", {});
                }, "Slack connected. Invite your bot to a channel and send your first mention.")
              }
            >
              Connect and check
            </Button>
          )}
        </div>
        <p className="text-sm text-ink-2 mt-3">Checks credentials, workspace membership, and the live Slack connection. Your first channel mention tests message access and replies.</p>
      </Section>
      {direct?.configured && (
        <Section title="Try it in Slack" description="Add your personal bot to a channel, then select it in Slack’s mention picker.">
          <p>
            Send <strong>@your-bot hello</strong> from the member account you connected. After the first mention, reply in the same thread without tagging it again.
          </p>
          <p className="text-sm text-ink-2 mt-2">
            Replies are visible to the channel. For private channels, invite the bot there too. Make sure your coding agent is signed in under Settings → Connections. If your bot stays silent, check
            its channel membership and that both tokens came from the same app.
          </p>
        </Section>
      )}
      <div aria-live="polite" className="settings-feedback">
        {directFeedback({ error, busy, connectionError: Boolean(direct?.error), notice })}
      </div>
    </>
  );
}

function directFeedback({ error, busy, connectionError, notice }: { error: string | null; busy: boolean; connectionError: boolean; notice: string | null }) {
  if (error) {
    return (
      <span role="alert" className="text-bad">
        {error}
      </span>
    );
  }
  if (busy) {
    return "Checking Slack…";
  }
  if (connectionError) {
    return "Resolve the connection error above, then retry.";
  }
  return notice ?? "Defaults are saved when you connect.";
}
