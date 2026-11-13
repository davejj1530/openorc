import { BookText, Brain, Cloud, Laptop, Link2, MessageSquare, Plug, Signal, SlidersHorizontal, Smartphone, SunMoon, Tablet } from "../components/icons";
import { SETTINGS_SECTIONS, type Route, type SettingsSection } from "./router";

/** Each section's name and icon, and the line that leads it; Skills fills the body edge to edge, with none. */
const presentation: Record<SettingsSection, { label: string; description?: string; Icon: typeof Brain }> = {
  usage: { label: "Usage", Icon: Signal },
  connections: { label: "Connections", description: "The agents and tools connected to OpenOrc.", Icon: Link2 },
  cloud: { label: "Cloud", description: "Where cloud threads run.", Icon: Cloud },
  slack: { label: "Slack", description: "Bring requests from Slack to this computer.", Icon: MessageSquare },
  phone: { label: "Phone", description: "Your threads, from your phone.", Icon: Smartphone },
  skills: { label: "Skills", Icon: BookText },
  connectors: { label: "Connectors", description: "The tools and services your agents reach.", Icon: Plug },
  devices: { label: "Devices", description: "Simulators and emulators for you and your agents.", Icon: Tablet },
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
