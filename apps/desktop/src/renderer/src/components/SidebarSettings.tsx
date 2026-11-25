import { ChevronLeft } from "./icons";
import { dismissCompactNavigation } from "../lib/compact-navigation";
import { closeSettings, useRouter, type Route } from "../lib/router";
import { useSettingsSections } from "../lib/settings-sections";

/** Settings' head: the chevron that leaves beside the name, one button back to the screen Settings was opened from. */
function SettingsHead() {
  return (
    <div className="settings-head">
      <button
        type="button"
        aria-label="Close Settings"
        className="sidebar-nav-row no-drag"
        onClick={() => {
          closeSettings();
          dismissCompactNavigation();
        }}
      >
        <span className="sidebar-nav-icon">
          <ChevronLeft size={18} />
        </span>
        <span className="sidebar-nav-label">Settings</span>
      </button>
    </div>
  );
}

/** Settings lists the sections this person has in the sidebar, under its head, the way back. */
export function SidebarSettings({ route }: { route: Extract<Route, { view: "settings" }> }) {
  const { sections, current } = useSettingsSections(route);
  const navigate = useRouter((s) => s.navigate);
  return (
    <div className="settings-destinations">
      <SettingsHead />
      <nav className="settings-sections" aria-label="Settings">
        {sections.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            aria-current={id === current.id ? "page" : undefined}
            className="sidebar-nav-row no-drag"
            onClick={() => {
              navigate({ view: "settings", section: id });
              dismissCompactNavigation();
            }}
          >
            <span className="sidebar-nav-icon">
              <Icon size={18} />
            </span>
            <span className="sidebar-nav-label">{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
