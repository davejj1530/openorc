import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { distroPaths, HostPreferences, localPaths } from "./host";
import { hostCores } from "./host-core";
import { closeWhenIdle, placeFolder } from "./host-controls";
import { wslDistro } from "./wsl/distro";

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const folder = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openorc-host-"));
  temporary.push(dir);
  return dir;
};

describe("where the core runs", () => {
  it("is this computer until someone chooses otherwise, whatever the file holds", () => {
    const file = path.join(folder(), "host.json");
    const preferences = new HostPreferences(file);
    expect(preferences.choice()).toEqual({ kind: "local" });
    for (const content of ["", "not json", "null", '{"host":{"kind":"wsl"}}', '{"host":{"kind":"wsl","distro":"../etc"}}', '{"host":{"kind":"ssh","distro":"Ubuntu"}}']) {
      writeFileSync(file, content);
      expect(preferences.choice()).toEqual({ kind: "local" });
    }
  });

  it("keeps a chosen distribution across restarts, and the way back", () => {
    const file = path.join(folder(), "host.json");
    new HostPreferences(file).set({ kind: "wsl", distro: "Ubuntu-24.04" });
    expect(new HostPreferences(file).choice()).toEqual({ kind: "wsl", distro: "Ubuntu-24.04" });
    new HostPreferences(file).set({ kind: "local" });
    expect(new HostPreferences(file).choice()).toEqual({ kind: "local" });
  });

  it("honours a chosen distribution only where there is WSL", () => {
    const input = { userData: folder(), coreDir: "/none", brainDir: null, fileKey: "k", qa: false, fetchNode: async () => Buffer.alloc(0), env: {} };
    const chosen = { kind: "wsl", distro: "Ubuntu" } as const;
    expect(hostCores({ ...input, platform: "win32" }).choice(chosen)).toEqual(chosen);
    expect(hostCores({ ...input, platform: "darwin" }).choice(chosen)).toEqual({ kind: "local" });
    expect(hostCores({ ...input, platform: "linux" }).choice(chosen)).toEqual({ kind: "local" });
    expect(hostCores({ ...input, platform: "linux" }).choice({ kind: "local" })).toEqual({ kind: "local" });
  });

  it("offers this machine as a stand-in distribution only to a development build that names one", async () => {
    const input = { userData: folder(), coreDir: "/none", brainDir: null, fileKey: "k", fetchNode: async () => Buffer.alloc(0), platform: "linux" as const, env: { OPENORC_WSL_STANDIN: "Ubuntu" } };
    expect(await hostCores({ ...input, qa: true }).distros()).toEqual([{ name: "Ubuntu", default: true, version: null }]);
    expect(hostCores({ ...input, qa: true }).choice({ kind: "wsl", distro: "Ubuntu" })).toEqual({ kind: "wsl", distro: "Ubuntu" });
    expect(await hostCores({ ...input, qa: false }).distros()).toEqual([]);
    expect(hostCores({ ...input, qa: false }).choice({ kind: "wsl", distro: "Ubuntu" })).toEqual({ kind: "local" });
  });

  it("keeps each distribution's secrets in a folder of its own beside this computer's", () => {
    const userData = folder();
    const cores = hostCores({ userData, coreDir: "/none", brainDir: null, fileKey: "k", qa: false, fetchNode: async () => Buffer.alloc(0), platform: "win32", env: {} });
    expect(cores.secretsDir({ kind: "local" })).toBe(userData);
    expect(cores.secretsDir({ kind: "wsl", distro: "Ubuntu" })).toBe(path.join(userData, "wsl", "ubuntu"));
  });
});

describe("paths between main and the core", () => {
  it("are the same on this computer", () => {
    const paths = localPaths("/profile");
    expect(paths.toMain("/repo/file.ts")).toBe("/repo/file.ts");
    expect(paths.toCore("/repo")).toBe("/repo");
    expect(paths.dataDir()).toBe("/profile");
    expect(paths.distro).toBeNull();
  });

  it("cross the share for a core inside a distribution, with the profile where the distribution keeps it", () => {
    let profile: string | null = null;
    const paths = distroPaths(wslDistro("Ubuntu", "wsl.exe"), () => profile, "C:\\nowhere");
    expect(paths.toMain("/home/me/repo")).toBe("\\\\wsl$\\Ubuntu\\home\\me\\repo");
    expect(paths.toCore("\\\\wsl.localhost\\Ubuntu\\home\\me\\repo")).toBe("/home/me/repo");
    expect(paths.toCore("C:\\Users\\me\\repo")).toBeNull();
    expect(paths.dataDir()).toBe("C:\\nowhere");
    profile = "/home/me/.openorc-wsl/data";
    expect(paths.dataDir()).toBe("\\\\wsl$\\Ubuntu\\home\\me\\.openorc-wsl\\data");
  });
});

describe("a chosen folder", () => {
  const ubuntu = wslDistro("Ubuntu", "wsl.exe");

  it("opens as it always has on this computer", () => {
    expect(placeFolder("/Users/me/repo", { kind: "local" }, (p) => p, "darwin")).toEqual({ kind: "open", path: "/Users/me/repo" });
    expect(placeFolder("C:\\Users\\me\\repo", { kind: "local" }, (p) => p, "win32")).toEqual({ kind: "open", path: "C:\\Users\\me\\repo" });
    // Off Windows a path that only looks like a share is a path like any other.
    expect(placeFolder("//wsl.localhost/Ubuntu/home", { kind: "local" }, (p) => p, "linux")).toEqual({ kind: "open", path: "//wsl.localhost/Ubuntu/home" });
  });

  it("belongs to the distribution it is inside, and can still be opened from Windows", () => {
    expect(placeFolder("\\\\wsl.localhost\\Ubuntu\\home\\me\\repo", { kind: "local" }, (p) => p, "win32")).toEqual({
      kind: "elsewhere",
      host: { kind: "wsl", distro: "Ubuntu" },
      path: "/home/me/repo",
      direct: "\\\\wsl.localhost\\Ubuntu\\home\\me\\repo",
    });
  });

  it("opens by its Linux path when the core runs in that distribution", () => {
    expect(placeFolder("\\\\wsl$\\Ubuntu\\home\\me\\repo", { kind: "wsl", distro: "Ubuntu" }, ubuntu.toInside, "win32")).toEqual({ kind: "open", path: "/home/me/repo" });
  });

  it("belongs to this PC or another distribution when it is outside the one the core runs in", () => {
    expect(placeFolder("C:\\Users\\me\\repo", { kind: "wsl", distro: "Ubuntu" }, ubuntu.toInside, "win32")).toEqual({
      kind: "elsewhere",
      host: { kind: "local" },
      path: "C:\\Users\\me\\repo",
      direct: null,
    });
    expect(placeFolder("\\\\wsl.localhost\\Debian\\srv\\app", { kind: "wsl", distro: "Ubuntu" }, ubuntu.toInside, "win32")).toEqual({
      kind: "elsewhere",
      host: { kind: "wsl", distro: "Debian" },
      path: "/srv/app",
      direct: null,
    });
  });
});

describe("closing the core for a switch", () => {
  const busy = { reason: "OpenOrc is processing a request. Try again in a moment.", retry: true };
  const agents = { reason: "Wait for agent work, approvals, and context maintenance to finish first, then switch.", retry: false };

  it("waits out a request caught mid-flight, and closes once the core is idle", async () => {
    const answers = [busy, busy, null];
    let asked = 0;
    expect(await closeWhenIdle(async () => answers[asked++] ?? null, { waitMs: 1 })).toBeNull();
    expect(asked).toBe(3);
  });

  it("does not wait on a refusal that needs the person, and gives up when requests never pause", async () => {
    let asked = 0;
    expect(await closeWhenIdle(async () => (asked++, agents), { waitMs: 1 })).toBe(agents.reason);
    expect(asked).toBe(1);
    expect(await closeWhenIdle(async () => busy, { attempts: 3, waitMs: 1 })).toBe(busy.reason);
  });
});
