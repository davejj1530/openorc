import { afterEach, describe, expect, it } from "vitest";
import { Db, settings } from "@openorc/db";
import { AppSettingsService } from "./settings.js";
const databases: Db[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
describe("settings persistence", () => {
  it("loads older settings and remembers the latest permission without losing other preferences", () => {
    const db = Db.memory();
    databases.push(db);
    settings.set(db, "app.settings", JSON.stringify({ sound: true, defaultWorkspaceMode: "worktree" }));
    const service = new AppSettingsService(db);
    expect(service.get()).toMatchObject({ sound: true, defaultWorkspaceMode: "worktree", defaultPermissionMode: "trusted", defaultHarness: null, experimentalTeamExecution: true });
    for (const permission of ["autonomous", "review", "trusted"] as const) {
      service.set({ defaultPermissionMode: permission });
      expect(new AppSettingsService(db).get()).toMatchObject({ sound: true, defaultWorkspaceMode: "worktree", defaultPermissionMode: permission });
    }
  });
  it("enables Beta for new profiles while preserving saved opt-outs", () => {
    const db = Db.memory();
    databases.push(db);
    const service = new AppSettingsService(db);
    expect(service.get().experimentalTeamExecution).toBe(true);
    service.set({ experimentalTeamExecution: false });
    const reopened = new AppSettingsService(db);
    reopened.set({ sound: true });
    expect(new AppSettingsService(db).get().experimentalTeamExecution).toBe(false);
  });
  it("persists every preference across service instances and preserves unrelated fields", () => {
    const db = Db.memory();
    databases.push(db);
    const service = new AppSettingsService(db);
    const values = {
      notifications: false,
      sound: true,
      autoDoneDays: null,
      autoDoneOnPrMerge: false,
      autoArchiveDoneDays: 30,
      defaultWorkspaceMode: "worktree" as const,
      defaultPermissionMode: "review" as const,
      defaultHarness: "claude" as const,
      look: { palette: "linear", colors: { dark: { "--accent": "#5e6ad2" } } },
      experimentalTeamExecution: true,
      idleProcessMinutes: null,
      claudeUserMcpServers: false,
    };
    service.set(values);
    const reopened = new AppSettingsService(db);
    expect(reopened.get()).toEqual(values);
    reopened.set({ notifications: true });
    expect(reopened.get()).toEqual({ ...values, notifications: true });
    expect(() => reopened.set({ autoDoneDays: -1 })).toThrow();
    expect(reopened.get().autoDoneDays).toBeNull();
    expect(() => reopened.set({ idleProcessMinutes: 0 })).toThrow();
    expect(reopened.get().idleProcessMinutes).toBeNull();
  });
  it("holds the desktop's look for phones, null until it is handed over, and reads one it cannot as none", () => {
    const db = Db.memory();
    databases.push(db);
    const service = new AppSettingsService(db);
    expect(service.get().look).toBeNull();
    service.set({ sound: true, look: { palette: "claude", colors: { light: { "--accent": "#b64e48" } } } });
    service.set({ notifications: false });
    expect(new AppSettingsService(db).get()).toMatchObject({ sound: true, notifications: false, look: { palette: "claude", colors: { light: { "--accent": "#b64e48" } } } });
    // A look saved by another version keeps every other setting.
    settings.set(db, "app.settings", JSON.stringify({ sound: true, defaultHarness: "codex", look: { palette: 7, colors: [] } }));
    expect(new AppSettingsService(db).get()).toMatchObject({ sound: true, defaultHarness: "codex", look: null });
  });
});
