import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
