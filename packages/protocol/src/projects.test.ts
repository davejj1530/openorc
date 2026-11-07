import { expect, it } from "vitest";
import { projectRpcParams } from "./projects.js";

const settings = projectRpcParams["projects.updateSettings"];

it("leaves a project's Claude accounts out of a settings patch from a client that does not know them", () => {
  const parsed = settings.parse({ id: "p", settings: { branchPrefix: "openorc", worktreeInclude: [], setupScript: null, somethingNewer: true } });
  expect(parsed.settings).toEqual({ branchPrefix: "openorc", worktreeInclude: [], setupScript: null });
  expect("claudeAccounts" in parsed.settings).toBe(false);
});

it("takes a project's Claude accounts, or null to follow the app's", () => {
  const claudeAccounts = { only: true, accountIds: ["work"], defaultId: "work", autoSwitch: false };
  expect(settings.parse({ id: "p", settings: { claudeAccounts } }).settings).toEqual({ claudeAccounts });
  expect(settings.parse({ id: "p", settings: { claudeAccounts: null } }).settings).toEqual({ claudeAccounts: null });
  expect(() => settings.parse({ id: "p", settings: { claudeAccounts: { ...claudeAccounts, accountIds: Array.from({ length: 51 }, (_, i) => `a${i}`) } } })).toThrow();
  expect(() => settings.parse({ id: "p", settings: { claudeAccounts: { only: true, accountIds: [""], defaultId: null, autoSwitch: false } } })).toThrow();
});
