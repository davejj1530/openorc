import { WORKSPACE_ID, type ClaudeAccountConnection, type ProjectClaudeAccounts } from "@openorc/protocol";
import { expect, it } from "vitest";
import { projectAccountChoice } from "./project-claude-accounts.js";

const account = (id: string, enabled = true): ClaudeAccountConnection => ({
  id,
  name: id,
  kind: "managed",
  enabled,
  createdAt: 1,
  status: enabled ? "ready" : "disabled",
  email: null,
  organization: null,
  message: null,
});
const list = { accounts: [account("cli"), account("work"), account("personal"), account("off", false)], defaultId: "cli" };
const project = (claudeAccounts?: ProjectClaudeAccounts | null, id = "project") => ({ id, settings: claudeAccounts === undefined ? {} : { claudeAccounts } });
const own = (patch: Partial<ProjectClaudeAccounts> = {}): ProjectClaudeAccounts => ({ only: true, accountIds: ["work", "personal"], defaultId: "personal", autoSwitch: false, ...patch });
const ids = (choice: ReturnType<typeof projectAccountChoice>) => [choice.restricted, choice.accounts.map(({ id }) => id), choice.defaultId];

it("offers the app's accounts and default for a project without its own, with them off, the Workspace, or none known", () => {
  const app = [false, ["cli", "work", "personal", "off"], "cli"];
  for (const each of [project(), project(null), project(own({ only: false })), project(own(), WORKSPACE_ID), null, undefined]) expect(ids(projectAccountChoice(each, list))).toEqual(app);
  // An older host sends projects without settings for accounts at all.
  expect(ids(projectAccountChoice({ id: "older" }, list))).toEqual(app);
});

it("offers a project's enabled accounts in the app's order, starting on its default while it is one of them", () => {
  expect(ids(projectAccountChoice(project(own({ accountIds: ["personal", "work", "off", "gone"] })), list))).toEqual([true, ["work", "personal"], "personal"]);
  expect(ids(projectAccountChoice(project(own({ defaultId: "off", accountIds: ["work", "off"] })), list))).toEqual([true, ["work"], "work"]);
  expect(ids(projectAccountChoice(project(own({ accountIds: ["off"], defaultId: "off" })), list))).toEqual([true, [], "cli"]);
});
