import type { DeviceHelpers, DevicePlatformSupport, DeviceStatus, DeviceTool } from "@openorc/protocol";

const purpose: Record<DeviceTool["name"], string> = {
  "expo-device-hub": "to stream and control devices",
  "agent-device": "so agents can tap and type",
};

/** The tools setup would install from npm: the hub always, agent-device only when agents get access. */
export const toolsToInstall = (tools: DeviceTool[], agentAccess: boolean): DeviceTool[] => tools.filter((tool) => (tool.name === "expo-device-hub" || agentAccess) && tool.installed !== tool.pinned);

/** One line saying what gets installed and why, or null when nothing would be. */
export function consentLine(tools: DeviceTool[], agentAccess: boolean): string | null {
  const phrases = toolsToInstall(tools, agentAccess).map((tool) => `${tool.name} ${tool.pinned} ${purpose[tool.name]}`);
  if (phrases.length === 0) return null;
  return `From npm, OpenOrc installs ${phrases.join(", and ")}.`;
}

/** What blocks a platform here: the platform itself, or for Android only its video. */
export function platformNote(support: DevicePlatformSupport): string | null {
  if (!support.available) return support.reason;
  return support.video?.available === false ? support.video.reason : null;
}

export function setupBlocked(status: DeviceStatus): string | null {
  if (status.blocked) return status.blocked;
  return status.platforms.some((platform) => platform.available) ? null : "Needs Xcode or the Android SDK first.";
}

/** What the helpers are doing while setup runs, in a few words; null when they are not busy. */
export function helpersProgress(helpers: DeviceHelpers): string | null {
  if (helpers.phase === "installing") return helpers.detail;
  if (helpers.phase === "starting") return "Starting";
  if (helpers.phase === "restarting") return "Restarting";
  return null;
}

export const helpersBusy = (helpers: DeviceHelpers | undefined): boolean => helpers !== undefined && helpersProgress(helpers) !== null;
