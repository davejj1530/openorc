import { ChevronLeft } from "./icons";
import { NavItem } from "./SidebarNav";
import { useRouter, type Route } from "../lib/router";
import { settingsSection, settingsSections } from "../lib/settings-sections";

/** Settings lists its sections in the sidebar, under a way back to the screen it was opened from. */
export function SidebarSettings({ route }: { route: Extract<Route, { view: "settings" }> }) {
  const opener = useRouter((s) => s.history.findLast((entry) => entry.view !== "settings"));
  const current = settingsSection(route).id;
  return (
    <div className="settings-destinations">
      <NavItem route={opener ?? { view: "newthread" }} icon={<ChevronLeft size={16} />} label="Back to app" active={false} />
      <nav className="grid grid-cols-1 gap-0.5 min-w-0" aria-label="Settings">
        {settingsSections.map(({ id, label, Icon }) => (
          <NavItem key={id} route={{ view: "settings", section: id }} icon={<Icon size={16} />} label={label} active={id === current} />
        ))}
      </nav>
    </div>
  );
}
