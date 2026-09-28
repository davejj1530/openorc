import { useState, type ReactNode } from "react";
import type { ReviewerAppStatus, SystemInfo } from "@openorc/protocol";
import { Badge, Button, TextButton } from "../components/ui";
import { useRpc, useRpcMutation } from "../lib/query";
import { installationLabel } from "./settings-presentation";
import { Section, Toggle } from "./settings-shared";

function SettingRow({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="settings-field">
      <span>
        <span className="font-medium">{label}</span>
        {hint ? <span className="block text-sm text-ink-2 mt-1">{hint}</span> : null}
      </span>
      <span className="flex shrink-0 flex-wrap items-center justify-end gap-2">{children}</span>
    </div>
  );
}

/** Choose where the app may review, let it approve, or forget it on this device. */
function ReviewerAppControls({ app, onRemoved }: { app: NonNullable<ReviewerAppStatus["app"]>; onRemoved: (slug: string) => void }) {
  const configure = useRpcMutation("reviewerApp.configure");
  const remove = useRpcMutation("reviewerApp.remove");
  const error = configure.error ?? remove.error;
  return (
    <>
      <SettingRow
        label="Reviewer app"
        hint={
          <>
            Reviews you post as the app show as <span className="whitespace-nowrap">{app.login}</span>.
          </>
        }
      >
        <Button onClick={() => window.openorc.openExternal(app.installUrl)}>Choose repositories</Button>
        <Button variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate({}, { onSuccess: () => onRemoved(app.slug) })}>
          Remove
        </Button>
      </SettingRow>
      <Toggle
        label="Let it approve"
        hint="An approval from the app can count toward required reviews, including on your own pull requests."
        checked={app.allowApprove}
        disabled={configure.isPending}
        onChange={(allowApprove) => configure.mutate({ allowApprove })}
      />
      {error ? (
        <p role="alert" className="text-bad mt-2">
          {error.message}
        </p>
      ) : null}
    </>
  );
}

/**
 * The GitHub App that posts reviews for you. Setup creates it on your GitHub
 * account in the browser; its key stays in this device's keychain.
 */
function ReviewerAppSetting() {
  const status = useRpc("reviewerApp.get", {});
  const setup = useRpcMutation("reviewerApp.setup");
  const cancel = useRpcMutation("reviewerApp.cancelSetup");
  const [removed, setRemoved] = useState<string | null>(null);
  const app = status.data?.app ?? null;
  const waiting = status.data?.setupUrl ?? null;
  const failure = setup.error?.message ?? status.data?.error ?? null;
  const begin = () => {
    setRemoved(null);
    setup.mutate({}, { onSuccess: ({ url }) => window.openorc.openExternal(url) });
  };
  if (app) return <ReviewerAppControls app={app} onRemoved={setRemoved} />;
  return (
    <>
      {waiting ? (
        <SettingRow label="Reviewer app" hint="Finish creating it on GitHub.">
          <Button onClick={() => window.openorc.openExternal(waiting)}>Open GitHub</Button>
          <Button variant="ghost" disabled={cancel.isPending} onClick={() => cancel.mutate({})}>
            Cancel
          </Button>
        </SettingRow>
      ) : (
        <SettingRow label="Reviewer app" hint="Post reviews as a bot on GitHub instead of your own account.">
          <Button disabled={setup.isPending || !status.data} onClick={begin}>
            Set up
          </Button>
        </SettingRow>
      )}
      {removed ? (
        <p role="status" className="text-ink-2 mt-2">
          Removed from OpenOrc. The app stays on GitHub until you{" "}
          <TextButton underline onClick={() => window.openorc.openExternal(`https://github.com/settings/apps/${removed}/advanced`)}>
            delete it there
          </TextButton>
          .
        </p>
      ) : null}
      {failure ? (
        <p role="alert" className="text-bad mt-2">
          {failure}
        </p>
      ) : null}
    </>
  );
}

/** How OpenOrc reaches GitHub: your GitHub CLI, and the reviewer app. */
export function GitHubSettings({ info }: { info: SystemInfo | undefined }) {
  return (
    <Section title="GitHub" description="Pull requests use the GitHub CLI installed on this device.">
      <SettingRow label="GitHub CLI" hint={info && !info.gh.installed ? "Install it to create pull requests. Push still works; OpenOrc opens the compare page instead." : null}>
        <Badge tone={info?.gh.installed ? "ok" : "muted"}>{installationLabel(Boolean(info), info?.gh.installed ?? false)}</Badge>
        <Button onClick={() => window.openorc.openExternal("https://cli.github.com")}>GitHub CLI setup</Button>
      </SettingRow>
      <ReviewerAppSetting />
    </Section>
  );
}
