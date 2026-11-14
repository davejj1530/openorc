import { Menu } from "@base-ui/react/menu";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { GithubConnectChoice, OrganizationRepositories } from "@openorc/protocol";
import { CoversPreview } from "../lib/browser-preview";
import { floatingGround } from "../lib/use-anchor-ground";
import { menuItem, menuPopup, menuSeparator } from "./menu";
import { Button, TextButton } from "./ui";

export function GithubRepositoryChooser({
  data,
  waiting,
  connect,
  label = "Choose repositories on GitHub",
  button = false,
}: {
  data: Pick<OrganizationRepositories, "configured" | "installations" | "available">;
  waiting: boolean;
  connect(choice: GithubConnectChoice): void;
  label?: string;
  button?: boolean;
}) {
  const disabled = !data.configured || waiting;
  const reason = !data.configured ? "GitHub isn't available on this server." : undefined;
  const text = waiting ? "Connecting…" : label;
  const trigger = button ? (
    <Button disabled={disabled} data-tip={reason}>
      {text}
    </Button>
  ) : (
    <TextButton tone="muted" className="text-sm" disabled={disabled} data-tip={reason}>
      {text}
    </TextButton>
  );
  const available = data.available ?? [];
  return (
    <Menu.Root>
      <div>
        <Menu.Trigger render={trigger} disabled={disabled} />
      </div>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner align="start" sideOffset={6} className="z-50">
          <Menu.Popup ref={floatingGround} className={menuPopup}>
            {data.installations.map((installation) => (
              <AccountEntry key={installation.id} installation={installation} />
            ))}
            {available.map((installation) => (
              <Menu.Item key={installation.installationId} className={menuItem} onClick={() => connect({ installationId: installation.installationId })}>
                Connect {installation.accountLogin}
              </Menu.Item>
            ))}
            {data.installations.length || available.length ? <Menu.Separator className={menuSeparator} /> : null}
            <Menu.Item className={menuItem} onClick={() => connect({ another: true })}>
              Another account or organization
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function AccountEntry({ installation }: { installation: OrganizationRepositories["installations"][number] }) {
  const { accountLogin, settingsUrl } = installation;
  if (settingsUrl)
    return (
      <Menu.Item className={menuItem} onClick={() => window.openorc.openExternal(settingsUrl)}>
        {accountLogin}
      </Menu.Item>
    );
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={<Menu.Item className={menuItem} disabled />}>{accountLogin}</BaseTooltip.Trigger>
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner sideOffset={6} className="z-50">
          <BaseTooltip.Popup ref={floatingGround} className="tooltip-popup">
            Can't open this account on GitHub right now.
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
