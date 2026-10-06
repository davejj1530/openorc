import { BookText, Brain, Laptop, Link2, MessageSquare, Signal, SlidersHorizontal, SunMoon } from "../components/icons";
import { SETTINGS_SECTIONS, type Route, type SettingsSection } from "./router";

const presentation: Record<SettingsSection, { label: string; description: string; Icon: typeof Brain }> = {
  usage: { label: "Usage", description: "Account allowances, across your providers.", Icon: Signal },
  connections: { label: "Connections", description: "The agents and tools connected to OpenOrc.", Icon: Link2 },
  slack: { label: "Slack", description: "Bring requests from Slack to this computer.", Icon: MessageSquare },
  skills: { label: "Skills", description: "Browse the skills your agents can use.", Icon: BookText },
  appearance: { label: "Appearance", description: "Your workspace, in your own colors.", Icon: SunMoon },
  general: { label: "General", description: "Everyday preferences for the way you work.", Icon: SlidersHorizontal },
  memory: { label: "Memory & models", description: "What OpenOrc remembers, and which models help.", Icon: Brain },
  data: { label: "Data", description: "Your work lives on this device.", Icon: Laptop },
};

/** Settings' sections, in the order the sidebar lists them. */
export const settingsSections = SETTINGS_SECTIONS.map((id) => ({ id, ...presentation[id] }));

/** The section a settings route opens: Usage, unless it names another. */
export function settingsSection(route: Extract<Route, { view: "settings" }>) {
  const id = route.section ?? "usage";
  return { id, ...presentation[id] };
}
