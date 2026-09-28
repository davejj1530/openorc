import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { App } from "electron";

/** Configure before Electron initializes OS encryption or takes the profile lock. */
export function configureAppIdentity(
  app: Pick<App, "isPackaged" | "getPath" | "setPath" | "setName"> & { once(event: "ready", listener: () => void): void },
  env: NodeJS.ProcessEnv = process.env,
): void {
  const dataDir = env["OPENORC_USER_DATA"] || join(app.getPath("appData"), "OpenOrc");
  mkdirSync(dataDir, { recursive: true });

  // Electron captures this name for safeStorage before `ready`; it selects the
  // macOS Keychain / Linux keyring entry. Development and packaged builds use
  // different entries so their encrypted files never mix.
  app.setName(app.isPackaged ? "OpenOrc" : "@openorc/desktop");
  app.setPath("userData", dataDir);
  app.once("ready", () => app.setName("OpenOrc"));
}
