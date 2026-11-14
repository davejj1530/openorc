import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { standIn, type StandIn } from "@openorc/hosted/testing";
import { HOSTED_FILES_UNAVAILABLE, hostedFilePath, type HostedFileScope } from "@openorc/protocol";
import { OpenOrc } from "../openorc.js";
import { HostedFiles } from "./hosted-files.js";

const EMAIL = "sender@example.com";
let directory: string;
let stand: StandIn;
let core: OpenOrc;
let files: HostedFiles;
let scope: HostedFileScope;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "openorc-file-restore-"));
  stand = await standIn({ signup: "open" });
  const projectId = stand.addProject(EMAIL, { name: "example", fullName: "sample/example" });
  let stored = "";
  core = await OpenOrc.create({
    dataDir: directory,
    ephemeral: true,
    transport: { push: () => undefined },
    accountServer: stand.url,
    accountSecrets: { load: async () => stored, save: async (value) => void (stored = value) },
    shellProbe: async () => {
      const none = "/usr/bin/false";
      return { path: process.env.PATH ?? "", binaries: { claude: none, codex: none, opencode: none, omp: none, cursor: none, pi: none, antigravity: none, fx: none } };
    },
    openBrowser: (url) => void fetch(stand.signInPage(url, EMAIL), { redirect: "manual" }),
  });
  await core.account!.account.signIn();
  await vi.waitFor(() => expect(core.account!.spaces.status()).toMatchObject({ state: "ready" }));
  files = new HostedFiles({ dataDir: directory, account: () => core.account, changed: () => undefined });
  scope = { accountId: `user-${EMAIL}`, apiOrigin: stand.url, spaceId: `personal-${EMAIL}`, destination: { kind: "hosted", projectId } };
});
afterEach(async () => {
  await files.close();
  await core.close();
  await stand.close();
  await rm(directory, { recursive: true, force: true });
});

async function sent(name: string): Promise<string> {
  const draft = { scope, draftKey: "first-draft", id: randomUUID() };
  await files.begin({ ...draft, name, bytes: 3, mime: "text/plain" });
  await files.append({ ...draft, offset: 0, data: Buffer.from(name.slice(0, 3)).toString("base64") });
  await files.finish(draft);
  const ready = await vi.waitFor(
    async () => {
      const file = (await files.state(draft)).files.find((row) => row.id === draft.id);
      if (file?.state.kind !== "ready") throw new Error("still uploading");
      return file.state.file;
    },
    { timeout: 5000 },
  );
  return hostedFilePath(ready);
}

it("puts a withdrawn message's files back into another draft by their ids, in order, once, without uploading them again", async () => {
  const notes = await sent("notes.txt");
  const plan = await sent("plan.md");
  const starts = () => stand.requests.filter((request) => request.method === "POST" && request.path === "/uploads").length;
  const before = starts();
  const edited = { scope, draftKey: "edited-draft" };
  await files.restore({ ...edited, paths: [plan, notes] });
  await files.restore({ ...edited, paths: [plan, notes] });
  const restored = (await files.state(edited)).files;
  expect(restored.map((file) => (file.state.kind === "ready" ? hostedFilePath(file.state.file) : file.state.kind))).toEqual([plan, notes]);
  expect(starts()).toBe(before);
});

it("refuses to restore what isn't a cloud file", async () => {
  await expect(files.restore({ scope, draftKey: "edited-draft", paths: ["/Users/sender/notes.txt"] })).rejects.toThrow("This file isn't available in this space.");
});

it("says files are unavailable until the server's files feature is on", async () => {
  expect(await files.availability(scope)).toEqual({ available: false, reason: HOSTED_FILES_UNAVAILABLE });
  stand.threadFiles.capabilities = { files: { available: true } };
  expect(await files.availability(scope)).toEqual({ available: true });
});
