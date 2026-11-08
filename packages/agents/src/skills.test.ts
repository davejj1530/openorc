import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SHARED_CLAUDE_CONFIG_DIR } from "./claude/config-dir.js";
import { MAX_ENTRIES, MAX_SKILL_BYTES, listSkills } from "./skills.js";

const temps: string[] = [];
async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

async function skill(dir: string, name: string, body: string): Promise<void> {
  await mkdir(path.join(dir, name), { recursive: true });
  await writeFile(path.join(dir, name, "SKILL.md"), body);
}

/** mkfifo is POSIX; on Windows there is nothing to build the blocking case out of. */
const posixIt = process.platform === "win32" ? it.skip : it;

let home: string;
let projectRoot: string;

beforeAll(async () => {
  // claudeConfigDir prefers this variable, and a developer running the suite may have it set.
  vi.stubEnv("CLAUDE_CONFIG_DIR", "");
  home = await temp("openorc-skills-home-");
  projectRoot = await temp("openorc-skills-project-");

  const user = path.join(home, ".claude", "skills");
  await skill(user, "shared", "---\nname: shared\ndescription: The user copy.\n---\n\nBody.\n");
  await skill(user, "paired", "---\nname: paired\ndescription: Also installed by a plugin.\n---\n");
  await skill(user, "quoted", '---\nname: quoted\ndescription: "Review changes: use when the user says \\"review since X\\"."\n---\n');
  await skill(user, "ticked", "---\nname: ticked\ndescription: 'It''s quoted the other way.'\n---\n");
  await skill(user, "folded", "---\nname: folded\ndescription: >\n  First clause of the trigger\n  and its continuation.\n\n  A second paragraph.\nlicense: MIT\n---\n");
  await skill(user, "literal", "---\nname: literal\ndescription: |\n  Line one.\n  Line two.\n---\n");
  await skill(user, "wrapped", "---\nname: wrapped\ndescription: A plain scalar that runs\n  onto the next line without a marker.\n---\n");
  await skill(user, "spaced", '---\nname: spaced\ndescription:  "Two spaces before the quote."\n---\n');
  await skill(user, "spaced-block", "---\nname: spaced-block\ndescription:  |\n  Two spaces before the block opener.\n---\n");
  await skill(user, "runaway", '---\nname: runaway\ndescription: "the quote never closes\n---\n\nBody text.\n\nname: body-leak\ndescription: body-leak-description\n');
  await skill(user, "huge", `---\nname: huge\ndescription: ${"x".repeat(MAX_SKILL_BYTES)}\n---\n`);
  await skill(user, "fallback-name", "---\ndescription: No name in the header.\n---\n");
  await skill(user, "bare", "# Just a document\n\nNo frontmatter at all.\n");
  await skill(user, "unterminated", "---\nname: unterminated\ndescription: The closing delimiter never arrives.\n");
  await mkdir(path.join(user, "broken", "SKILL.md"), { recursive: true });
  await mkdir(path.join(user, "empty"), { recursive: true });
  await writeFile(path.join(user, "loose.md"), "not a skill directory");

  const plugin = path.join(home, "plugins", "demo", "skills");
  await skill(plugin, "shared", "---\nname: shared\ndescription: The demo plugin copy of shared.\n---\n");
  await skill(plugin, "paired", "---\nname: paired\ndescription: The demo plugin copy of paired.\n---\n");
  await skill(plugin, "only-plugin", "---\nname: only-plugin\ndescription: Nowhere else.\n---\n");
  // A manifest key with no marketplace suffix, and a skill whose header name differs from its directory.
  await skill(path.join(home, "plugins", "plain", "skills"), "tidy", "---\nname: tidy-header\ndescription: From a plugin with no marketplace suffix.\n---\n");
  // A key with nothing before the "@" yields no prefix, and a "/name" we cannot spell is one we must not offer.
  await skill(path.join(home, "plugins", "scoped", "skills"), "unnameable", "---\nname: unnameable\ndescription: No handle exists for this.\n---\n");
  await mkdir(path.join(home, ".claude", "plugins"), { recursive: true });
  await writeFile(
    path.join(home, ".claude", "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "demo@market": [{ scope: "user", installPath: path.join(home, "plugins", "demo") }],
        plain: [{ scope: "user", installPath: path.join(home, "plugins", "plain") }],
        "@scoped@market": [{ scope: "user", installPath: path.join(home, "plugins", "scoped") }],
        "gone@market": [{ scope: "user" }],
        "junk@market": "not an array",
      },
    }),
  );

  await skill(path.join(projectRoot, ".claude", "skills"), "shared", "---\nname: shared\ndescription: The project copy.\n---\n");
  await mkdir(path.join(projectRoot, ".git"));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("listSkills", () => {
  it("lists every readable skill by name, skipping loose files and directories without a SKILL.md", async () => {
    const found = await listSkills({ projectRoot, home, agent: "claude" });
    expect(found.map((s) => s.name)).toEqual([
      "bare",
      "demo:only-plugin",
      "demo:paired",
      "demo:shared",
      "fallback-name",
      "folded",
      "huge",
      "literal",
      "paired",
      "plain:tidy",
      "quoted",
      "runaway",
      "shared",
      "spaced",
      "spaced-block",
      "ticked",
      "unterminated",
      "wrapped",
    ]);
    expect(found.find((skill) => skill.name === "shared")?.source).toBe("user");
  });

  it("lists Claude's custom commands by path, namespacing subfolders and letting a skill win a shared name", async () => {
    const root = await temp("openorc-skills-commands-");
    const configDir = await temp("openorc-skills-commands-config-");
    const commands = path.join(root, ".claude", "commands");
    await mkdir(path.join(commands, "ops"), { recursive: true });
    await writeFile(path.join(commands, "fix-bug.md"), "---\nname: ignored-header\ndescription: >-\n  Fix a bug\n  with a test.\n---\n\nBody.\n");
    await writeFile(path.join(commands, "CHEATSHEET.md"), "# No header at all\n");
    await writeFile(path.join(commands, "notes.txt"), "Not a command.\n");
    await writeFile(path.join(commands, "ops", "deploy.md"), "Deploy it.\n");
    await writeFile(path.join(commands, "both.md"), "---\ndescription: The command.\n---\n");
    await skill(path.join(root, ".claude", "skills"), "both", "---\nname: both\ndescription: The skill.\n---\n");
    await mkdir(path.join(configDir, "commands"));
    await writeFile(path.join(configDir, "commands", "mine.md"), "Mine.\n");
    const plugin = path.join(configDir, "cache", "demo");
    await mkdir(path.join(plugin, "commands"), { recursive: true });
    await writeFile(path.join(plugin, "commands", "ship.md"), "---\ndescription: Ship it.\n---\n");
    await mkdir(path.join(configDir, "plugins"));
    await writeFile(path.join(configDir, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "demo@market": [{ installPath: plugin }] } }));

    const found = await listSkills({ projectRoot: root, home, agent: "claude", env: { CLAUDE_CONFIG_DIR: configDir } });

    expect(found.map((s) => `${s.source}:${s.name}`).sort()).toEqual(["plugin:demo:ship", "project:CHEATSHEET", "project:both", "project:fix-bug", "project:ops:deploy", "user:mine"].sort());
    expect(found.find((s) => s.name === "fix-bug")?.description).toBe("Fix a bug with a test.");
    expect(found.find((s) => s.name === "both")?.description).toBe("The skill.");
    expect(found.find((s) => s.name === "CHEATSHEET")?.description).toBe("No header at all");
    expect(found.find((s) => s.name === "ops:deploy")?.description).toBe("Deploy it.");
  });

  it("lists the skills and commands of every folder up to the repository's root, the nearest copy of a name winning, as the CLI does", async () => {
    const outside = await temp("openorc-skills-nested-");
    const repo = path.join(outside, "repo");
    const web = path.join(repo, "apps", "web");
    await skill(path.join(outside, ".claude", "skills"), "above", "---\nname: above\ndescription: Outside the repository.\n---\n");
    await mkdir(path.join(repo, ".git"), { recursive: true });
    await skill(path.join(repo, ".claude", "skills"), "dup", "---\nname: dup\ndescription: The root copy.\n---\n");
    await skill(path.join(repo, ".claude", "skills"), "root-only", "---\nname: root-only\ndescription: Only at the root.\n---\n");
    await mkdir(path.join(repo, ".claude", "commands"), { recursive: true });
    await writeFile(path.join(repo, ".claude", "commands", "root-command.md"), "A root command.\n");
    await skill(path.join(web, ".claude", "skills"), "dup", "---\nname: dup\ndescription: The web copy.\n---\n");
    const configDir = await temp("openorc-skills-nested-config-");

    const found = await listSkills({ projectRoot: web, home, agent: "claude", env: { CLAUDE_CONFIG_DIR: configDir } });

    expect(found.map((s) => `${s.source}:${s.name}:${s.description}`)).toEqual(["project:dup:The web copy.", "project:root-command:A root command.", "project:root-only:Only at the root."]);
  });

  it("lists a command folder holding a SKILL.md as one command and its subfolders after it, as the CLI does, and leaves out names it could not run", async () => {
    const root = await temp("openorc-skills-command-skill-");
    const configDir = await temp("openorc-skills-command-skill-config-");
    const commands = path.join(root, ".claude", "commands");
    await skill(commands, "review", "---\ndescription: Review it.\n---\n");
    await writeFile(path.join(commands, "review", "checklist.md"), "Not its own command.\n");
    await mkdir(path.join(commands, "review", "refs"));
    await writeFile(path.join(commands, "review", "refs", "more.md"), "A command of its own.\n");
    await skill(path.join(commands, "ops"), "deep", "---\ndescription: Nested.\n---\n");
    await writeFile(path.join(commands, ".md"), "No name.\n");
    await writeFile(path.join(commands, "my notes.md"), "Reads as /my with an argument.\n");
    await writeFile(path.join(commands, "unclosed.md"), "---\nname: unclosed\n");
    const plugin = path.join(configDir, "cache", "demo");
    await skill(path.join(plugin, "commands"), "audit", "---\ndescription: From a plugin.\n---\n");
    await writeFile(path.join(plugin, "commands", "audit", "notes.md"), "Not its own command.\n");
    // A plugin's folder ends at its SKILL.md, subfolders and all.
    await mkdir(path.join(plugin, "commands", "audit", "deeper"));
    await writeFile(path.join(plugin, "commands", "audit", "deeper", "more.md"), "Not listed.\n");
    await mkdir(path.join(configDir, "plugins"));
    await writeFile(path.join(configDir, "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "demo@market": [{ installPath: plugin }] } }));

    const found = await listSkills({ projectRoot: root, home, agent: "claude", env: { CLAUDE_CONFIG_DIR: configDir } });

    expect(found.map((s) => s.name)).toEqual(["demo:audit", "ops:deep", "review", "review:refs:more", "unclosed"]);
    expect(found.find((s) => s.name === "review")?.description).toBe("Review it.");
    expect(found.find((s) => s.name === "unclosed")?.description).toBe("");
  });

  it("keeps a project's subfolder commands past a stray skill.md at the top of its commands, as the CLI does", async () => {
    const root = await temp("openorc-skills-command-stray-");
    const commands = path.join(root, ".claude", "commands");
    await mkdir(path.join(commands, "ops"), { recursive: true });
    await writeFile(path.join(commands, "skill.md"), "A stray one.\n");
    await writeFile(path.join(commands, "top.md"), "Beside the stray one, so its own file.\n");
    await writeFile(path.join(commands, "ops", "deploy.md"), "Deploy it.\n");

    const found = await listSkills({ projectRoot: root, home, agent: "claude", env: { CLAUDE_CONFIG_DIR: await temp("openorc-skills-command-stray-config-") } });

    expect(found.map((s) => s.name)).toEqual(["commands", "ops:deploy"]);
  });

  posixIt("does not list a command folder again through a link back up the tree", async () => {
    const root = await temp("openorc-skills-command-cycle-");
    const commands = path.join(root, ".claude", "commands");
    await mkdir(path.join(commands, "ops"), { recursive: true });
    await writeFile(path.join(commands, "ops", "deploy.md"), "Deploy it.\n");
    await writeFile(path.join(commands, "plain.md"), "Plain.\n");
    await symlink(commands, path.join(commands, "self"));
    await symlink(commands, path.join(commands, "ops", "back"));
    await mkdir(path.join(root, "elsewhere"));
    await writeFile(path.join(root, "elsewhere", "linked.md"), "Through a link.\n");
    await symlink(path.join(root, "elsewhere"), path.join(commands, "shared"));

    const found = await listSkills({ projectRoot: root, home, agent: "claude", env: { CLAUDE_CONFIG_DIR: await temp("openorc-skills-command-cycle-config-") } });

    expect(found.map((s) => s.name)).toEqual(["ops:deploy", "plain", "shared:linked"]);
  });

  it("gives an added account its own skills and the plugins the CLI login turns on", async () => {
    const account = await temp("openorc-skills-account-");
    await skill(path.join(account, "skills"), "own", "---\nname: own\ndescription: Installed in the account.\n---\n");
    const shared = await temp("openorc-skills-shared-");
    await mkdir(path.join(shared, "plugins"));
    await writeFile(
      path.join(shared, "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "demo@market": [{ scope: "user", installPath: path.join(home, "plugins", "demo") }], plain: [{ scope: "user", installPath: path.join(home, "plugins", "plain") }] },
      }),
    );
    await writeFile(path.join(shared, "settings.json"), JSON.stringify({ enabledPlugins: { "demo@market": true, plain: false } }));
    const found = await listSkills({ projectRoot, home, agent: "claude", env: { CLAUDE_CONFIG_DIR: account, [SHARED_CLAUDE_CONFIG_DIR]: shared } });
    expect(found.map((s) => s.name)).toEqual(["demo:only-plugin", "demo:paired", "demo:shared", "own", "shared"]);
  });

  it("discovers OpenCode's compatible, native, nested, and flat skills with its source precedence", async () => {
    await skill(path.join(home, ".agents", "skills"), "shared", "---\nname: Different display name\ndescription: From agents.\n---\n");
    await skill(path.join(home, ".config", "opencode", "skills"), "shared", "---\nname: Another label\ndescription: From global OpenCode.\n---\n");
    await skill(path.join(projectRoot, ".opencode", "skills"), "shared", "---\nname: Custom display name\ndescription: From project OpenCode.\n---\n");
    await skill(path.join(projectRoot, ".opencode", "skills", "teams"), "release", "---\nname: Release checklist\ndescription: Nested project skill.\n---\n");
    await writeFile(path.join(projectRoot, ".opencode", "skills", "audit.md"), "---\ndescription: Flat project skill.\n---\n");
    await skill(path.join(projectRoot, "team-skills"), "shared", "---\ndescription: From configured source.\n---\n");
    await writeFile(path.join(projectRoot, "opencode.jsonc"), '{ // OpenCode combines this with standard locations\n "skills": ["./team-skills"],\n}\n');
    const found = await listSkills({ projectRoot, home, agent: "opencode", env: {}, nativeDiscovery: false });
    expect(found.find((entry) => entry.name === "shared")).toMatchObject({ description: "From configured source.", source: "project" });
    expect(found.find((entry) => entry.name === "release")?.description).toBe("Nested project skill.");
    expect(found.find((entry) => entry.name === "audit")?.description).toBe("Flat project skill.");
    expect(found.some((entry) => entry.name === "demo:shared")).toBe(false);
    const withoutClaude = await listSkills({ projectRoot, home, agent: "opencode", env: { OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1" }, nativeDiscovery: false });
    expect(withoutClaude.some((entry) => entry.name === "paired")).toBe(false);
  });

  it("leaves OpenCode the staging copies Claude keeps in hidden folders", async () => {
    await skill(path.join(home, ".claude", "skills", "synced", "account", ".staging", "20339"), ".replaced-20339-abc", "---\ndescription: A staged copy.\n---\n");
    await skill(path.join(home, ".claude", "skills", "synced", "account"), "pptx", "---\ndescription: Slides.\n---\n");
    const found = await listSkills({ projectRoot, home, agent: "opencode", env: {}, nativeDiscovery: false });
    expect(found.some((entry) => entry.name.startsWith(".replaced"))).toBe(false);
    expect(found.find((entry) => entry.name === "pptx")?.description).toBe("Slides.");
  });

  it("reads a configured OpenCode HTTP catalog", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/catalog/index.json") response.end(JSON.stringify({ skills: [{ name: "remote", version: "1", files: ["remote.md"] }] }));
      else if (request.url === "/catalog/remote/remote.md") response.end("---\nname: Display only\ndescription: From the HTTP catalog.\n---\n");
      else {
        response.statusCode = 404;
        response.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("HTTP catalog test did not bind a port");
      const root = await temp("openorc-skills-remote-");
      await mkdir(path.join(root, ".git"));
      await writeFile(path.join(root, "opencode.json"), JSON.stringify({ skills: [`http://127.0.0.1:${address.port}/catalog/`] }));
      const found = await listSkills({ projectRoot: root, home: root, agent: "opencode", env: {}, nativeDiscovery: false });
      expect(found).toEqual([{ name: "remote", description: "From the HTTP catalog.", source: "project", path: `http://127.0.0.1:${address.port}/catalog/remote/remote.md` }]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("spends the entry cap on skills, so junk sorted ahead of them cannot evict them", async () => {
    const root = await temp("openorc-skills-junk-");
    const skills = path.join(root, ".claude", "skills");
    await mkdir(skills, { recursive: true });
    const junk = (prefix: string, n: number) => `${prefix}-${String(n).padStart(4, "0")}`;
    await Promise.all(Array.from({ length: 400 }, (_, n) => writeFile(path.join(skills, `${junk("000-loose", n)}.md`), "not a skill")));
    await Promise.all(Array.from({ length: 250 }, (_, n) => mkdir(path.join(skills, junk("111-empty", n)), { recursive: true })));
    await skill(skills, "zz-real-one", "---\nname: zz-real-one\ndescription: Behind the junk.\n---\n");
    await skill(skills, "zz-real-two", "---\nname: zz-real-two\ndescription: Also behind the junk.\n---\n");
    expect((await listSkills({ projectRoot: root, home: root, agent: "claude" })).map((s) => s.name)).toEqual(["zz-real-one", "zz-real-two"]);
  });

  it("still caps the number of skills it returns", async () => {
    const root = await temp("openorc-skills-cap-");
    const skills = path.join(root, ".claude", "skills");
    await mkdir(skills, { recursive: true });
    const names = Array.from({ length: MAX_ENTRIES + 3 }, (_, n) => `s-${String(n).padStart(4, "0")}`);
    await Promise.all(names.map((name) => skill(skills, name, `---\nname: ${name}\ndescription: One of many.\n---\n`)));
    const found = await listSkills({ projectRoot: root, home: root, agent: "claude" });
    expect(found).toHaveLength(MAX_ENTRIES);
    expect(found[0]?.name).toBe("s-0000");
  });

  posixIt(
    "settles when a SKILL.md is a FIFO with no writer, rather than parking on the open",
    async () => {
      const root = await temp("openorc-skills-fifo-");
      const skills = path.join(root, ".claude", "skills");
      await skill(skills, "regular", "---\nname: regular\ndescription: A real file.\n---\n");
      await mkdir(path.join(skills, "piped"), { recursive: true });
      await promisify(execFile)("mkfifo", [path.join(skills, "piped", "SKILL.md")]);
      expect((await listSkills({ projectRoot: root, home: root, agent: "claude" })).map((s) => s.name)).toEqual(["regular"]);
    },
    5_000,
  );

  it("returns nothing rather than throwing when no home, config or skills directory exists", async () => {
    const bare = await temp("openorc-skills-bare-");
    await expect(listSkills({ projectRoot: path.join(bare, "no-project"), home: path.join(bare, "no-home"), agent: "claude" })).resolves.toEqual([]);
  });
});
