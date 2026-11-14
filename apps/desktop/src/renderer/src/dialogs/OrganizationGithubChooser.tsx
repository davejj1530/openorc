import { Menu } from "@base-ui/react/menu";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import type { OrganizationRepositories } from "@openorc/protocol";
import { CoversPreview } from "../lib/browser-preview";
import { floatingGround } from "../lib/use-anchor-ground";
import { menuItem, menuPopup, menuSeparator } from "../components/menu";
import { TextButton } from "../components/ui";

export function OrganizationGithubChooser({ data, waiting, connect }: { data: OrganizationRepositories; waiting: boolean; connect(another: boolean): void }) {
  const trigger = (
    <TextButton
      tone="muted"
      className="text-sm"
      disabled={!data.configured || waiting}
      data-tip={!data.configured ? "GitHub isn't available on this server." : undefined}
      onClick={data.installations.length ? undefined : () => connect(false)}
    >
      {waiting ? "Connecting…" : "Choose repositories on GitHub"}
    </TextButton>
  );
  if (!data.installations.length) return <div>{trigger}</div>;
  return (
    <Menu.Root>
      <div>
        <Menu.Trigger render={trigger} disabled={!data.configured || waiting} />
      </div>
      <Menu.Portal>
        <CoversPreview />
        <Menu.Positioner align="start" sideOffset={6} className="z-50">
          <Menu.Popup ref={floatingGround} className={menuPopup}>
            {data.installations.map((installation) => (
              <AccountEntry key={installation.id} installation={installation} />
            ))}
            <Menu.Separator className={menuSeparator} />
            <Menu.Item className={menuItem} onClick={() => connect(true)}>
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
