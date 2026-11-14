import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { standIn, type StandIn } from "@openorc/hosted/testing";
import { HOSTED_FILE_CHUNK_BYTES, HOSTED_FILE_MAX_BYTES, type HostedFileScope } from "@openorc/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OpenOrc } from "../openorc.js";
import { rpcClient } from "../rpc-test-client.js";

const email = "sender@example.com";
let directory: string;
let stand: StandIn;
let core: OpenOrc;
let scope: HostedFileScope;
const call = rpcClient(() => core);
const pushes: unknown[] = [];

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "openorc-file-rpc-"));
  stand = await standIn({ signup: "open" });
  const projectId = stand.addProject(email, { name: "example", fullName: "sample/example" });
  let stored = "";
  pushes.length = 0;
  core = await OpenOrc.create({
    dataDir: directory,
    ephemeral: true,
    transport: { push: (push) => void pushes.push(push) },
    accountServer: stand.url,
    accountSecrets: { load: async () => stored, save: async (value) => void (stored = value) },
    chooseDownload: async () => path.join(directory, "download.bin"),
    openBrowser: (url) => void fetch(stand.signInPage(url, email), { redirect: "manual" }),
    shellProbe: async () => ({
      path: process.env.PATH ?? "",
      binaries: {
        claude: "/usr/bin/false",
        codex: "/usr/bin/false",
        opencode: "/usr/bin/false",
        omp: "/usr/bin/false",
        cursor: "/usr/bin/false",
        pi: "/usr/bin/false",
        antigravity: "/usr/bin/false",
        fx: "/usr/bin/false",
      },
    }),
  });
  await call("account.signIn", {});
  await vi.waitFor(async () => expect(await call("spaces.status", {})).toMatchObject({ state: "ready" }));
  scope = await call("hostedFiles.capture", { scope: { accountId: `user-${email}`, apiOrigin: stand.url, spaceId: `personal-${email}`, destination: { kind: "hosted", projectId } } });
});
afterEach(async () => {
  await core.close();
  await stand.close();
  await rm(directory, { recursive: true, force: true });
});

function ref() {
  return { scope, draftKey: "conversation-draft", id: randomUUID() };
}

it("imports bounded chunks over RPC, resumes from the durable offset and publishes only safe draft metadata", async () => {
  const input = ref();
  const bytes = Buffer.alloc(HOSTED_FILE_CHUNK_BYTES + 27, 64);
  expect(await call("hostedFiles.begin", { ...input, name: "notes.bin", bytes: bytes.length, mime: "application/octet-stream" })).toMatchObject({ imported: 0, state: { kind: "importing" } });
  const first = { ...input, offset: 0, data: bytes.subarray(0, HOSTED_FILE_CHUNK_BYTES).toString("base64") };
  expect(await call("hostedFiles.append", first)).toEqual({ imported: HOSTED_FILE_CHUNK_BYTES });
  expect(await call("hostedFiles.append", first)).toEqual({ imported: HOSTED_FILE_CHUNK_BYTES });
  expect((await call("hostedFiles.state", { scope: input.scope, draftKey: input.draftKey })).files[0]?.imported).toBe(HOSTED_FILE_CHUNK_BYTES);
  await call("hostedFiles.append", { ...input, offset: HOSTED_FILE_CHUNK_BYTES, data: bytes.subarray(HOSTED_FILE_CHUNK_BYTES).toString("base64") });
  await call("hostedFiles.finish", input);
  await vi.waitFor(async () => expect((await call("hostedFiles.state", { scope: input.scope, draftKey: input.draftKey })).files[0]?.state.kind).toBe("ready"));
  const row = (await call("hostedFiles.state", { scope: input.scope, draftKey: input.draftKey })).files[0]!;
  expect(Object.keys(row).sort()).toEqual(["bytes", "id", "imported", "mime", "name", "selectedAt", "state"]);
  if (row.state.kind !== "ready") throw new Error("Expected a completed upload");
  expect(await call("hostedFiles.download", { scope, file: { id: row.state.file.id, name: row.state.file.name } })).toEqual({ saved: true });
  expect(await readFile(path.join(directory, "download.bin"))).toEqual(bytes);
  await call("hostedFiles.accepted", input);
  await call("hostedFiles.accepted", input);
  expect((await call("hostedFiles.state", { scope: input.scope, draftKey: input.draftKey })).files).toEqual([]);
  expect(pushes).toContainEqual({ type: "invalidate", keys: ["hostedFiles"] });
});

it("keeps the exact file-limit refusal on its file and never starts that upload", async () => {
  const input = ref();
  expect(await call("hostedFiles.begin", { ...input, name: "large.bin", bytes: HOSTED_FILE_MAX_BYTES + 1, mime: "application/octet-stream" })).toMatchObject({
    state: { kind: "failed", message: "Keep files under 500 MB.", retryable: false },
  });
  expect(stand.requests.filter((request) => request.path === "/uploads")).toEqual([]);
  await call("hostedFiles.remove", input);
  await vi.waitFor(async () => expect((await call("hostedFiles.state", { scope: input.scope, draftKey: input.draftKey })).files).toEqual([]));
});

it("keeps drafts in their captured account and clears a readable preview after sign-out", async () => {
  const input = ref();
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWNIK+9IK+9ggFAAJpIFlVMG4ZAAAAAASUVORK5CYII=", "base64");
  await call("hostedFiles.begin", { ...input, name: "picture.png", bytes: bytes.length, mime: "image/png" });
  await call("hostedFiles.append", { ...input, offset: 0, data: bytes.toString("base64") });
  expect(await call("hostedFiles.preview", input)).toEqual({ contentType: "image/png", data: bytes.toString("base64") });
  await expect(call("hostedFiles.state", { draftKey: input.draftKey, scope: { ...scope, accountId: "someone-else" } })).rejects.toThrow("Your OpenOrc session changed. Try again.");
  await call("account.signOut", {});
  await expect(call("hostedFiles.preview", input)).rejects.toThrow("Your OpenOrc session changed. Try again.");
});
