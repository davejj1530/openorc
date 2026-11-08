import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newSkillText, withSkillIcon } from "./skill-interface.js";
import { setSkillEnabled } from "./skill-switches.js";
import { listSkills, skillHeader } from "./skills.js";

let root: string;
let home: string;
let projectRoot: string;
let configDir: string;

async function skill(dir: string, name: string, files: Record<string, string> = {}): Promise<string> {
  const folder = path.join(dir, name);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: The ${name} fixture.\n---\n`);
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(folder, file)), { recursive: true });
    await writeFile(path.join(folder, file), text);
  }
  return path.join(folder, "SKILL.md");
}

const claude = () => listSkills({ projectRoot, agent: "claude", home, env: { CLAUDE_CONFIG_DIR: configDir } });
const openCode = () => listSkills({ projectRoot, agent: "opencode", home, env: { XDG_CONFIG_HOME: path.join(home, ".config") }, nativeDiscovery: false });

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "openorc-skill-switches-"));
  home = path.join(root, "home");
  projectRoot = path.join(root, "project");
  configDir = path.join(root, "claude");
  await mkdir(path.join(projectRoot, ".git"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("what a listing says about each skill", () => {
  it("reads the interface file of a Claude skill, its image from inside its folder only", async () => {
    await writeFile(path.join(root, "secret.png"), "not for listing");
    await skill(path.join(configDir, "skills"), "release-notes", {
      "agents/openai.yaml": 'interface:\n  display_name: "Release Notes"\n  short_description: "Draft the notes"\n  icon_small: "./assets/icon.svg"\n',
      "assets/icon.svg": "<svg/>",
    });
    await skill(path.join(configDir, "skills"), "leaky", { "agents/openai.yaml": 'interface:\n  icon_small: "../../../secret.png"\n' });
    const [leaky, notes] = await claude();
    expect(notes).toMatchObject({ displayName: "Release Notes", shortDescription: "Draft the notes", icon: `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}` });
    expect(leaky).not.toHaveProperty("icon");
  });

  it("lets the user change their own and the project's skills, but not ones a claude.ai sync keeps", async () => {
    await skill(path.join(home, ".claude", "skills"), "mine");
    await skill(path.join(home, ".claude", "skills", "synced", "account"), "pptx");
    await skill(path.join(projectRoot, ".opencode", "skills"), "deploy");
    expect(Object.fromEntries((await openCode()).map((each) => [each.name, each.editable]))).toEqual({ deploy: true, mine: true, pptx: false });
  });

  it("marks a Claude skill off as the user's, project's and local settings merge, the later winning", async () => {
    await skill(path.join(configDir, "skills"), "notes");
    await skill(path.join(configDir, "skills"), "drafts");
    await writeFile(path.join(configDir, "settings.json"), JSON.stringify({ skillOverrides: { notes: "off", drafts: "off" } }));
    await mkdir(path.join(projectRoot, ".claude"), { recursive: true });
    await writeFile(path.join(projectRoot, ".claude", "settings.local.json"), JSON.stringify({ skillOverrides: { drafts: "name-only" } }));
    expect((await claude()).map((each) => [each.name, each.enabled])).toEqual([
      ["drafts", true],
      ["notes", false],
    ]);
  });
});

describe("turning a skill on and off", () => {
  it("writes Claude's skillOverrides in the account's settings, keeping every other key", async () => {
    const notes = await skill(path.join(configDir, "skills"), "notes");
    await writeFile(path.join(configDir, "settings.json"), '{\n  "model": "opus",\n  "skillOverrides": { "drafts": "name-only" }\n}\n');
    const env = { CLAUDE_CONFIG_DIR: configDir };

    expect(await setSkillEnabled({ agent: "claude", skill: { name: "notes", path: notes }, enabled: false, projectRoot, home, env })).toBe(false);
    expect(JSON.parse(await readFile(path.join(configDir, "settings.json"), "utf8"))).toEqual({ model: "opus", skillOverrides: { drafts: "name-only", notes: "off" } });
    expect((await claude()).find((each) => each.name === "notes")?.enabled).toBe(false);

    expect(await setSkillEnabled({ agent: "claude", skill: { name: "notes", path: notes }, enabled: true, projectRoot, home, env })).toBe(true);
    expect(JSON.parse(await readFile(path.join(configDir, "settings.json"), "utf8"))).toEqual({ model: "opus", skillOverrides: { drafts: "name-only" } });
  });

  it("writes through a linked Claude settings file and says when the project's settings still keep a skill off", async () => {
    const notes = await skill(path.join(configDir, "skills"), "notes");
    const dotfiles = path.join(root, "dotfiles");
    await mkdir(dotfiles, { recursive: true });
    await writeFile(path.join(dotfiles, "settings.json"), "{}\n");
    await symlink(path.join(dotfiles, "settings.json"), path.join(configDir, "settings.json"));
    await mkdir(path.join(projectRoot, ".claude"), { recursive: true });
    await writeFile(path.join(projectRoot, ".claude", "settings.json"), JSON.stringify({ skillOverrides: { notes: "off" } }));

    expect(await setSkillEnabled({ agent: "claude", skill: { name: "notes", path: notes }, enabled: true, projectRoot, home, env: { CLAUDE_CONFIG_DIR: configDir } })).toBe(false);
    await setSkillEnabled({ agent: "claude", skill: { name: "notes", path: notes }, enabled: false, projectRoot, home, env: { CLAUDE_CONFIG_DIR: configDir } });
    expect(JSON.parse(await readFile(path.join(dotfiles, "settings.json"), "utf8"))).toEqual({ skillOverrides: { notes: "off" } });
  });

  it("writes an OpenCode policy that denies the skill, keeping the user's comments, and lists it off", async () => {
    const config = path.join(home, ".config", "opencode");
    const notes = await skill(path.join(config, "skills"), "notes");
    await writeFile(path.join(config, "opencode.jsonc"), '{\n  // mine\n  "policies": [{ "action": "mcp.use", "resource": "github", "effect": "deny" }]\n}\n');
    const env = { XDG_CONFIG_HOME: path.join(home, ".config") };

    expect(await setSkillEnabled({ agent: "opencode", skill: { name: "notes", path: notes }, enabled: false, projectRoot, home, env })).toBe(false);
    const written = await readFile(path.join(config, "opencode.jsonc"), "utf8");
    expect(written).toContain("// mine");
    expect(JSON.parse(written.replace("// mine", ""))).toEqual({
      policies: [
        { action: "mcp.use", resource: "github", effect: "deny" },
        { action: "skill.use", resource: "notes", effect: "deny" },
      ],
    });
    expect((await openCode()).find((each) => each.name === "notes")?.enabled).toBe(false);

    expect(await setSkillEnabled({ agent: "opencode", skill: { name: "notes", path: notes }, enabled: true, projectRoot, home, env })).toBe(true);
    expect(JSON.parse((await readFile(path.join(config, "opencode.jsonc"), "utf8")).replace("// mine", ""))).toEqual({ policies: [{ action: "mcp.use", resource: "github", effect: "deny" }] });
  });

  it("reads OpenCode's patterns, the last matching rule deciding", async () => {
    const config = path.join(home, ".config", "opencode");
    await skill(path.join(config, "skills"), "draft-notes");
    await skill(path.join(config, "skills"), "draft-mail");
    await writeFile(
      path.join(config, "opencode.json"),
      JSON.stringify({
        policies: [
          { action: "skill.use", resource: "draft-*", effect: "deny" },
          { action: "integration.use", resource: "skill:draft-mail", effect: "allow" },
        ],
      }),
    );
    expect((await openCode()).map((each) => [each.name, each.enabled])).toEqual([
      ["draft-mail", true],
      ["draft-notes", false],
    ]);
  });
});

describe("a skill's files", () => {
  it("points the interface at a new image and keeps every other key", () => {
    const source = 'interface:\n  display_name: "Notes"\n  icon_large: "./assets/old.png"\npolicy:\n  allow_implicit_invocation: false\n';
    expect(withSkillIcon(source, "./assets/icon.png")).toBe(
      'interface:\n  display_name: "Notes"\n  icon_small: "./assets/icon.png"\n  icon_large: "./assets/icon.png"\npolicy:\n  allow_implicit_invocation: false\n',
    );
    expect(withSkillIcon(source, null)).toBe('interface:\n  display_name: "Notes"\npolicy:\n  allow_implicit_invocation: false\n');
    expect(withSkillIcon(null, null)).toBeNull();
    expect(withSkillIcon("interface:\n  display_name: Notes # mine\n", null)).toBe("interface:\n  display_name: Notes # mine\n");
    expect(() => withSkillIcon("interface: [unclosed", "./assets/icon.png")).toThrow("could not be read");
  });

  it("writes a new SKILL.md whose header the listing reads back", () => {
    const text = newSkillText("notes", 'Keeps notes: "short" ones.\nAnd long ones.', "  Write things down.  ");
    expect(skillHeader(text)).toEqual({ name: "notes", description: 'Keeps notes: "short" ones.\nAnd long ones.' });
    expect(text.endsWith("\nWrite things down.\n")).toBe(true);
  });
});
