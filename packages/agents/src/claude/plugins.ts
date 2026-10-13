import { readFileSync } from "node:fs";
import path from "node:path";

/** A plugin installed into one Claude config folder. */
export interface InstalledClaudePlugin {
  /** What the CLI prefixes onto every skill the plugin ships. */
  name: string;
  dir: string;
  /** Whether that folder's own settings turn it on. */
  enabled: boolean;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Installed plugins, from the manifest Claude Code writes rather than by
 * walking the plugin cache: the cache holds every version ever fetched, and
 * only the installed one is a plugin the CLI would load. The manifest key
 * carries the plugin's name, so it travels with the directory.
 */
export function installedClaudePlugins(configDir: string): InstalledClaudePlugin[] {
  const plugins = (readJson(path.join(configDir, "plugins", "installed_plugins.json")) as { plugins?: unknown } | null)?.plugins;
  if (typeof plugins !== "object" || plugins === null) return [];
  // Only this key is read: the rest of the settings belong to the login that owns them.
  const enabled = (readJson(path.join(configDir, "settings.json")) as { enabledPlugins?: Record<string, unknown> } | null)?.enabledPlugins ?? {};
  const found: InstalledClaudePlugin[] = [];
  for (const [key, installs] of Object.entries(plugins as Record<string, unknown>)) {
    if (!Array.isArray(installs)) continue;
    // "figma@claude-plugins-official" is figma from that marketplace; only the name reaches the prompt.
    const name = key.split("@")[0] ?? "";
    // With no name there is no handle to offer, and a wrong "/name" costs more than a missing one.
    if (!name) continue;
    for (const install of installs as unknown[]) {
      const dir = install && typeof install === "object" ? (install as { installPath?: unknown }).installPath : null;
      if (typeof dir === "string" && dir) found.push({ name, dir, enabled: enabled[key] === true });
    }
  }
  return found.sort((a, b) => a.dir.localeCompare(b.dir));
}
