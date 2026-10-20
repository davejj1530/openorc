import { Button, Input } from "../components/ui";
import { slackPersonalCreateUrl, slackPersonalManifest } from "../lib/slack-setup";

/** The steps to create a personal Slack app, as a disclosure card. Open until the bot is configured. */
export function SlackSetupGuide({
  open,
  appName,
  onAppName,
  act,
}: {
  open: boolean;
  appName: string;
  onAppName: (name: string) => void;
  act: (operation: () => Promise<unknown>, success: string) => Promise<void>;
}) {
  return (
    <details open={open} className="settings-disclosure">
      <summary>Set up your Slack app</summary>
      <ol className="slack-guide">
        <li>
          <p>Create a personal app</p>
          <p className="slack-guide-detail">
            Choose a distinct name, such as OpenOrc Personal. Open the setup link, choose your workspace, review the prefilled settings, and create the app. Your workspace may require admin approval.
          </p>
          <div className="flex flex-wrap items-end gap-2 mt-3">
            <label className="grid flex-1 min-w-0 gap-1.5 text-sm text-ink-3">
              App name
              <Input aria-label="App name" maxLength={35} value={appName} onChange={(e) => onAppName(e.target.value)} />
            </label>
            <Button size="lg" onClick={() => window.openorc.openExternal(slackPersonalCreateUrl(appName))}>
              Create Slack app
            </Button>
            <Button
              size="lg"
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
          <p className="slack-guide-detail mt-2">
            The template enables Socket Mode, approval buttons, channel/thread events, and image attachments. If the link does not prefill the form, use Copy manifest.
          </p>
          <p className="slack-guide-detail mt-2">
            Already connected? To receive images, add the files:read bot scope under OAuth &amp; Permissions in your Slack app, then reinstall it to your workspace.
          </p>
        </li>
        <li>
          <p>Install the app and copy its bot token</p>
          <p className="slack-guide-detail">In Slack’s app settings, open OAuth &amp; Permissions → Install to Workspace. Approve access, then copy the Bot User OAuth Token beginning with xoxb-.</p>
        </li>
        <li>
          <p>Generate an app token</p>
          <p className="slack-guide-detail">
            Open Basic Information → App-Level Tokens → Generate Token and Scopes. Name it OpenOrc desktop, add connections:write, then copy the token beginning with xapp-. Use tokens from the same
            app.
          </p>
        </li>
        <li>
          <p>Copy your Slack member ID</p>
          <p className="slack-guide-detail">In Slack, open your own profile → More → Copy member ID. Only requests and approvals from this member will control your computer.</p>
        </li>
      </ol>
      <Button className="mt-4" onClick={() => window.openorc.openExternal("https://api.slack.com/apps")}>
        Open Slack app settings
      </Button>
    </details>
  );
}
