import { useLayout } from "../lib/layout";
import { SCREENS } from "./sidebar-screens";
import { Dialog, Switch } from "./ui";

/** Which screens the sidebar lists; each one switched off waits under More. */
export function SidebarEdit({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const hidden = useLayout((s) => s.hiddenScreens);
  const setScreenShown = useLayout((s) => s.setScreenShown);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Edit sidebar" width={360}>
      <div className="sidebar-edit">
        {SCREENS.map(({ id, label, Icon }) => (
          <label key={id} className="sidebar-edit-row">
            <Icon size={16} className="sidebar-nav-icon" />
            <span className="sidebar-nav-label">{label}</span>
            <Switch checked={!hidden.includes(id)} onChange={(event) => setScreenShown(id, event.target.checked)} />
          </label>
        ))}
      </div>
    </Dialog>
  );
}
