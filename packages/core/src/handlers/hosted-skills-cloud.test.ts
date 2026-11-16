import { Db, settings } from "@openorc/db";
import type { CloudSkill, HarnessId } from "@openorc/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { HostedSkills } from "../services/hosted-skills.js";
import { AppSettingsService } from "../services/settings.js";
import { createHostedSkillsCloudHandlers } from "./hosted-skills-cloud.js";

const databases: Db[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** Skills that answer from the settings the handlers keep, as core's HostedSkills does. */
function setUp() {
  const db = Db.memory();
  databases.push(db);
  const kept = new AppSettingsService(db);
  const names = ["review", "notes", "ux"];
  const catalog = async (agent: HarnessId): Promise<CloudSkill[]> =>
    names.map((name) => ({ name, description: "", bytes: 10, on: !(kept.get().cloudSkillsOff[agent] ?? []).includes(name), cause: null }));
  const handlers = createHostedSkillsCloudHandlers(() => ({ catalog, leftOut: () => [] }) as unknown as HostedSkills, kept);
  const on = (list: CloudSkill[]) => list.filter((skill) => skill.on).map((skill) => skill.name);
  return { db, kept, handlers, on };
}

describe("the person's choice of which skills go to the cloud", () => {
  it("keeps one agent's skills from the cloud and sends them again, leaving the other agents' choices as they are", async () => {
    const { kept, handlers, on } = setUp();
    await handlers["hostedSkills.choose"]({ agent: "codex", names: ["review"], on: false });
    expect(on(await handlers["hostedSkills.choose"]({ agent: "claude", names: ["notes", "ux"], on: false }))).toEqual(["review"]);
    expect(on(await handlers["hostedSkills.choose"]({ agent: "claude", names: ["ux"], on: true }))).toEqual(["review", "ux"]);
    expect(kept.get().cloudSkillsOff).toEqual({ codex: ["review"], claude: ["notes"] });
    expect(on(await handlers["hostedSkills.choose"]({ agent: "claude", names: ["review", "notes", "ux"], on: true }))).toEqual(["review", "notes", "ux"]);
    expect(on(await handlers["hostedSkills.choose"]({ agent: "claude", names: ["review", "notes", "ux"], on: false }))).toEqual([]);
    expect(kept.get().cloudSkillsOff.claude).toEqual(["review", "notes", "ux"]);
  });

  it("reads settings saved before the choice existed as every skill going", () => {
    const { db } = setUp();
    settings.set(db, "app.settings", JSON.stringify({ sound: true }));
    expect(new AppSettingsService(db).get().cloudSkillsOff).toEqual({});
  });

  it("answers no skills without OpenOrc Cloud", async () => {
    const db = Db.memory();
    databases.push(db);
    const handlers = createHostedSkillsCloudHandlers(() => null, new AppSettingsService(db));
    expect(await handlers["hostedSkills.list"]({ agent: "claude" })).toEqual([]);
  });
});
