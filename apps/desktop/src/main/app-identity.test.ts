import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAppIdentity } from "./app-identity";

let appData: string;
beforeEach(() => {
  appData = mkdtempSync(join(tmpdir(), "openorc-identity-"));
});
afterEach(() => rmSync(appData, { recursive: true, force: true }));

function app(isPackaged = true) {
  return Object.assign(new EventEmitter(), { isPackaged, getPath: () => appData, setPath: vi.fn(), setName: vi.fn() });
}

describe("OpenOrc application identity", () => {
  it("creates a profile for a new installation", () => {
    const instance = app();
    configureAppIdentity(instance, {});
    expect(instance.setPath).toHaveBeenCalledWith("userData", join(appData, "OpenOrc"));
    expect(existsSync(join(appData, "OpenOrc"))).toBe(true);
  });

  it.each([
    { packaged: true, storageName: "OpenOrc" },
    { packaged: false, storageName: "@openorc/desktop" },
  ])("sets the encryption name until Electron is ready (packaged: $packaged)", ({ packaged, storageName }) => {
    const instance = app(packaged);
    configureAppIdentity(instance, {});
    expect(instance.setName.mock.calls).toEqual([[storageName]]);
    instance.emit("ready");
    expect(instance.setName.mock.calls).toEqual([[storageName], ["OpenOrc"]]);
  });
});
