import { projects } from "@openorc/db";
import { standIn, type StandIn } from "@openorc/hosted/testing";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OpenOrc } from "../openorc.js";
import { rpcClient } from "../rpc-test-client.js";

/**
 * The whole way from skill folders on this computer to the server: the core reads Claude's own skills where its
 * default account keeps them, and a send to a cloud thread makes them the server's first. The stand-in reads each pack
 * as the server does and refuses one that is not a skill.
 */
const EMAIL = "ada@example.com";
const binaries = {
  claude: "/usr/bin/false",
  codex: "/usr/bin/false",
  opencode: "/usr/bin/false",
  omp: "/usr/bin/false",
  cursor: "/usr/bin/false",
  pi: "/usr/bin/false",
  antigravity: "/usr/bin/false",
  fx: "/usr/bin/false",
};

let stand: StandIn;
let folder: string;
let core: OpenOrc;
const call = rpcClient(() => core);

beforeEach(async () => {
  stand = await standIn({ signup: "open" });
  folder = await mkdtemp(path.join(tmpdir(), "openorc-skills-send-"));
  const home = path.join(folder, "claude");
  vi.stubEnv("CLAUDE_CONFIG_DIR", home);
  // One skill kept in Claude's own folder, and one kept elsewhere that Claude's folder links to, as shared skills are.
  await mkdir(path.join(home, "skills", "review", "scripts"), { recursive: true });
  await writeFile(path.join(home, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Read the diff before answering.\n---\n\nRead the diff.\n");
  await writeFile(path.join(home, "skills", "review", "scripts", "check.sh"), "#!/bin/sh\necho ok\n");
  await chmod(path.join(home, "skills", "review", "scripts", "check.sh"), 0o755);
  await mkdir(path.join(folder, "shared", "ship"), { recursive: true });
  await writeFile(path.join(folder, "shared", "ship", "SKILL.md"), "---\nname: ship\ndescription: Ship once the tests pass.\n---\n\nShip it.\n");
  await symlink(path.join(folder, "shared", "ship"), path.join(home, "skills", "ship"));
  let stored: string | null = null;
  core = await OpenOrc.create({
    dataDir: path.join(folder, "data"),
    transport: { push: () => undefined },
    accountServer: stand.url,
    accountSecrets: { load: async () => stored, save: async (value) => void (stored = value) },
    openBrowser: (url) => void (new URL(url).pathname === "/sign-in" && fetch(stand.signInPage(url, EMAIL))),
    shellProbe: async () => ({ path: process.env.PATH ?? "", binaries }),
  });
});

afterEach(async () => {
  await core.close();
  await stand.close();
  vi.unstubAllEnvs();
  await rm(folder, { recursive: true, force: true });
});

it("sends this computer's own skills to the server before a message to a cloud thread, as packs the server takes", async () => {
  stand.threadFiles.capabilities = { skills: { available: true } };
  stand.setBilling(EMAIL, { pro: true, standing: "live", at: new Date(Date.now() + 86_400_000).toISOString(), monthlyLeftSeconds: 3600, packsLeftSeconds: 0 });
  stand.setSignIns(EMAIL, [{ agent: "claude" }]);
  const project = projects.insert(core.db, { name: "openorc", rootPath: folder, gitRemote: "https://github.com/altalogy/openorc.git", defaultBranch: "main", settings: {} });
  const hosted = stand.addThread(EMAIL, { projectId: stand.addProject(EMAIL, { name: "openorc", fullName: "altalogy/openorc" }), title: "Send to me" });
  await call("account.signIn", {});
  await vi.waitFor(async () => expect((await call("threads.list", { projectIds: [project.id], filter: "active", includeChildren: true })).some((row) => row.id === hosted)).toBe(true), {
    timeout: 5_000,
  });

  await call("runs.start", { threadId: hosted, agent: "claude", mode: "act", permissionMode: "trusted", prompt: "Go", messageId: `user-${crypto.randomUUID()}` });

  expect(stand.skills.set(EMAIL, "claude")).toEqual(["review", "ship"]);
  const [review, ship] = stand.skills.sent.map((sent) => stand.skills.pack(EMAIL, sent.digest)!);
  const skillFile = "---\nname: review\ndescription: Read the diff before answering.\n---\n\nRead the diff.\n";
  expect(review!.toString()).toBe(`review/SKILL.md\0-\0${skillFile.length}\0${skillFile}review/scripts/check.sh\0x\x0018\0#!/bin/sh\necho ok\n`);
  expect(ship!.toString()).toContain("ship/SKILL.md\0-\0");
  expect(stand.skills.sent.map((sent) => sent.digest)).toEqual([review!, ship!].map((pack) => createHash("sha256").update(pack).digest("hex")));
  expect(stand.sent).toHaveLength(1);
});
