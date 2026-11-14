import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createHosted, type CloudFileScope, type Hosted } from "./index.js";
import { hostDeps, newDevice, signInAs } from "./test-fixtures/host.js";
import { standIn, type StandIn } from "./testing/stand-in.js";

const EMAIL = "sender@example.com";
let stand: StandIn;
const hosts: Hosted[] = [];
beforeEach(async () => {
  stand = await standIn({ signup: "open" });
});
afterEach(async () => {
  for (const host of hosts.splice(0)) host.close();
  await stand.close();
});

async function device(email = EMAIL, override: Parameters<typeof hostDeps>[2] = {}) {
  const { deps, browser, seen } = hostDeps(stand, newDevice(), override);
  const host = createHosted(deps);
  hosts.push(host);
  await host.start();
  await signInAs(host, browser, email);
  await host.spaces.refresh();
  return { host, browser, seen };
}

async function scope(host: Hosted, projectId: string, spaceId = `personal-${EMAIL}`): Promise<CloudFileScope> {
  const status = host.spaces.status();
  if (status.state !== "ready") throw new Error("Expected spaces");
  return host.files.capture({ accountId: status.userId, apiOrigin: status.apiOrigin, spaceId, destination: { kind: "hosted", projectId } });
}

async function upload(host: Hosted, captured: CloudFileScope, bytes: Buffer, name = "notes.txt") {
  const plan = await host.files.start(captured, { name, bytes: bytes.length, requestId: randomUUID() });
  for (let part = 1; part <= plan.parts; part++)
    await host.files.part(
      captured,
      plan,
      part,
      { bytes: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) },
      { signal: new AbortController().signal, progress: () => undefined },
    );
  return host.files.complete(captured, plan.id);
}

it("uploads multiple exact parts and downloads the original through the captured space", async () => {
  const project = stand.addProject(EMAIL, { name: "example", fullName: "sample/example" });
  const { host } = await device();
  const captured = await scope(host, project);
  const bytes = Buffer.alloc(8 * 1024 * 1024 + 37, 101);
  bytes.write("Last part", bytes.length - 9);
  const file = await upload(host, captured, bytes, "folder/notes.txt");
  expect(file).toMatchObject({ name: "notes.txt", bytes: bytes.length, kind: "file" });
  const actual = await host.files.read(captured, file, false, async (response) => Buffer.from(await response.arrayBuffer()));
  expect(actual.equals(bytes)).toBe(true);
  expect(await host.files.complete(captured, file.id)).toEqual(file);
  await expect(host.files.read(captured, file, true, (response) => response.arrayBuffer())).rejects.toThrow("That file has no thumbnail.");
});

it("replays a lost start by its draft request ID and never renews a cancelled or expired reservation", async () => {
  const project = stand.addProject(EMAIL, { name: "example", fullName: "sample/example" });
  const { host } = await device();
  const captured = await scope(host, project);
  const input = { name: "notes.txt", bytes: 10, requestId: randomUUID() };
  const plan = await host.files.start(captured, input);
  expect(await host.files.start(captured, input)).toEqual(plan);
  await expect(host.files.start(captured, { ...input, bytes: 11 })).rejects.toThrow("That upload request id was already used for a different file.");
  await host.files.cancel(captured, plan.id);
  await expect(host.files.start(captured, input)).rejects.toThrow("This upload expired. Retry to upload the file again.");
  const next = await host.files.start(captured, { ...input, requestId: randomUUID() });
  stand.uploads.expire(next.id);
  await expect(host.files.complete(captured, next.id)).rejects.toThrow("This upload expired. Retry to upload the file again.");
});

it("cancels a pending start and recovers that reservation by its saved request ID", async () => {
  const project = stand.addProject(EMAIL, { name: "example", fullName: "sample/example" });
  let hold = true;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const { host } = await device(EMAIL, {
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (!hold || new URL(String(url)).pathname !== "/uploads") return response;
      await response.body?.cancel();
      entered();
      return new Promise<Response>((_resolve, reject) => {
        const cancel = () => reject(init?.signal?.reason);
        if (init?.signal?.aborted) cancel();
        else init?.signal?.addEventListener("abort", cancel, { once: true });
      });
    },
  });
  const captured = await scope(host, project);
  const input = { name: "notes.txt", bytes: 10, requestId: randomUUID() };
  const control = new AbortController();
  const starting = host.files.start(captured, input, control.signal);
  const failed = expect(starting).rejects.toThrow("Removed from this draft.");
  await started;
  control.abort(new Error("Removed from this draft."));
  await failed;
  hold = false;
  const recovered = await host.files.start(captured, input);
  expect(await host.files.start(captured, input)).toEqual(recovered);
  await host.files.cancel(captured, recovered.id);
  await expect(host.files.complete(captured, recovered.id)).rejects.toThrow("This upload expired. Retry to upload the file again.");
});

it("cancels a part without completing it and can retry that same part", async () => {
  const project = stand.addProject(EMAIL, { name: "example", fullName: "sample/example" });
  const { host } = await device();
  const captured = await scope(host, project);
  const bytes = Buffer.alloc(1024 * 1024, 81);
  const plan = await host.files.start(captured, { name: "sample.bin", bytes: bytes.length, requestId: randomUUID() });
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const held = new Promise<void>((resolve) => (release = resolve));
  const source = {
    bytes: bytes.length,
    read: async (offset: number, length: number) => {
      if (offset) {
        entered();
        await held;
      }
      return bytes.subarray(offset, offset + length);
    },
  };
  const control = new AbortController();
  const sending = host.files.part(captured, plan, 1, source, { signal: control.signal, progress: () => undefined });
  const failed = expect(sending).rejects.toThrow("Upload stopped.");
  await started;
  control.abort(new Error("Upload stopped."));
  await failed;
  release();
  await expect(host.files.complete(captured, plan.id)).rejects.toThrow("Some of the file hasn't arrived yet.");
  await host.files.part(captured, plan, 1, source, { signal: new AbortController().signal, progress: () => undefined });
  const file = await host.files.complete(captured, plan.id);
  const original = await host.files.read(captured, file, false, async (response) => Buffer.from(await response.arrayBuffer()));
  expect(original.equals(bytes)).toBe(true);
});

it("retains the server's words for empty and oversized files and admits exactly 500 MB", async () => {
  const project = stand.addProject(EMAIL, { name: "example", fullName: "sample/example" });
  const { host } = await device();
  const captured = await scope(host, project);
  const input = { name: "archive.zip", requestId: randomUUID() };
  await expect(host.files.start(captured, { ...input, bytes: 0 })).rejects.toThrow("That file is empty.");
  await expect(host.files.start(captured, { ...input, bytes: 500 * 1024 * 1024 + 1 })).rejects.toMatchObject({ status: 413, code: "file_too_large", message: "Keep files under 500 MB." });
  expect(await host.files.start(captured, { ...input, bytes: 500 * 1024 * 1024 })).toMatchObject({ parts: 63, partBytes: 8 * 1024 * 1024 });
});

it("allows a teammate to read an attached picture and refuses the same file after project access is removed", async () => {
  const reader = "reader@example.com";
  const team = stand.addTeam("Example team", [EMAIL, reader]);
  const project = stand.addProject(EMAIL, { name: "example", fullName: "sample/example" }, team);
  const sender = await device();
  const captured = await scope(sender.host, project, team);
  const bytes = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#667788" } })
    .png()
    .toBuffer();
  const file = await upload(sender.host, captured, bytes, "drawing");
  const teammate = await device(reader);
  const reading = await scope(teammate.host, project, team);
  await expect(teammate.host.files.read(reading, file, false, (response) => response.arrayBuffer())).rejects.toThrow("That file isn't here.");
  expect(stand.uploads.attach({ who: EMAIL, space: team, ids: [file.id], projectId: project, messageId: randomUUID() })).toEqual([file]);
  const preview = await teammate.host.files.read(reading, file, true, async (response) => Buffer.from(await response.arrayBuffer()));
  expect(await sharp(preview).metadata()).toMatchObject({ format: "webp", width: 640, height: 427 });
  stand.spaces.project(team, project)!.everyone = false;
  await expect(teammate.host.files.read(reading, file, false, (response) => response.arrayBuffer())).rejects.toThrow("That file isn't here.");
});

it("cannot retarget a retained draft when the account changes", async () => {
  const project = stand.addProject(EMAIL, { name: "example", fullName: "sample/example" });
  const { host, browser } = await device();
  const captured = await scope(host, project);
  await host.account.signOut();
  await signInAs(host, browser, "another@example.com");
  await host.spaces.refresh();
  await expect(host.files.start(captured, { name: "notes.txt", bytes: 3, requestId: randomUUID() })).rejects.toThrow("Your OpenOrc session changed. Try again.");
  expect(stand.requests.some((request) => request.path === "/uploads")).toBe(false);
});

it("discards protected bytes if sign-out happens before their consumer completes", async () => {
  const project = stand.addProject(EMAIL, { name: "example", fullName: "sample/example" });
  const { host, seen } = await device();
  const captured = await scope(host, project);
  const file = await upload(host, captured, Buffer.from("Private bytes"));
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const waiting = new Promise<void>((resolve) => (release = resolve));
  const reading = host.files.read(captured, file, false, async (response) => {
    const bytes = await response.arrayBuffer();
    entered();
    await waiting;
    return bytes;
  });
  const result = expect(reading).rejects.toThrow("Your OpenOrc session changed. Try again.");
  await started;
  await host.account.signOut();
  release();
  await result;
  expect(seen.pushes).toContainEqual({ type: "invalidate", keys: ["hostedFiles", "hostedAssets"] });
});
