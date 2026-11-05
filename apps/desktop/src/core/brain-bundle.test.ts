import { mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { newestBrainBundle } from "./brain-bundle";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(os.tmpdir(), "openorc-brain-dist-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it("picks the newest brain archive and reads it only when asked", async () => {
  await writeFile(join(dir, "brain-old0001.tgz"), "old");
  await writeFile(join(dir, "brain-new0002.tgz"), "new");
  await writeFile(join(dir, "brain-later.tgz.partial"), "partial");
  await utimes(join(dir, "brain-old0001.tgz"), 1_000, 1_000);
  await utimes(join(dir, "brain-new0002.tgz"), 2_000, 2_000);
  const bundle = await newestBrainBundle(dir);
  expect(bundle?.version).toBe("new0002");
  expect((await bundle!.read()).toString()).toBe("new");
});

it("carries the newest door beside the brain, read only when deployed", async () => {
  await writeFile(join(dir, "brain-new0002.tgz"), "new");
  expect((await newestBrainBundle(dir))?.door).toBeUndefined();
  await writeFile(join(dir, "door-aaaaaaaaaaaa.mjs"), "old door");
  await writeFile(join(dir, "door-bbbbbbbbbbbb.mjs"), "new door");
  await writeFile(join(dir, "door-notadigest.mjs"), "not a door");
  await utimes(join(dir, "door-aaaaaaaaaaaa.mjs"), 1_000, 1_000);
  await utimes(join(dir, "door-bbbbbbbbbbbb.mjs"), 2_000, 2_000);
  const door = (await newestBrainBundle(dir))?.door;
  expect(door?.release).toBe("bbbbbbbbbbbb");
  expect((await door!.code()).toString()).toBe("new door");
});

it("finds none in a build without the brain's folder, or once its archive is gone", async () => {
  expect(await newestBrainBundle(join(dir, "missing"))).toBeNull();
  await writeFile(join(dir, "app.tgz"), "not a brain");
  await symlink(join(dir, "replaced-by-a-build.tgz"), join(dir, "brain-gone0003.tgz"));
  expect(await newestBrainBundle(dir)).toBeNull();
});
