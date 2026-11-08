import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Db, settings } from "@openorc/db";
import type { Connector } from "@openorc/protocol";
import { afterEach, beforeEach, expect, it } from "vitest";
import { rememberedConnectors } from "./remembered-connectors.js";

let dir: string;
let db: Db;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "remembered-connectors-"));
  db = Db.open(path.join(dir, "ledger.sqlite"));
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const connector = (name: string): Connector => ({
  name,
  title: name,
  kind: "url",
  logo: null,
  agents: [{ agent: "claude", source: "user", editable: true, switchable: true, places: [{ status: "connected" }] }],
});

it("keeps each folder's last list across a restart, the eight folders read most recently", () => {
  const first = rememberedConnectors(db);
  for (let index = 0; index < 9; index += 1) first.save(`/project-${index}`, [connector(`server-${index}`)]);
  expect(first.load("/project-0")).toBeNull();
  // Read again, a folder counts as the newest, so the next new one drops the oldest after it.
  first.save("/project-1", [connector("paper")]);
  first.save("/project-9", [connector("server-9")]);

  const next = rememberedConnectors(db);
  expect(next.load("/project-1")).toEqual([connector("paper")]);
  expect(next.load("/project-9")).toEqual([connector("server-9")]);
  expect(next.load("/project-2")).toBeNull();
  expect(next.load("/project-3")).toEqual([connector("server-3")]);
});

it("forgets an entry it cannot read rather than answering with it", () => {
  settings.set(db, "connectors.remembered", JSON.stringify({ "/project": [{ name: "paper" }] }));
  expect(rememberedConnectors(db).load("/project")).toBeNull();
  settings.set(db, "connectors.remembered", "{not json");
  expect(rememberedConnectors(db).load("/project")).toBeNull();
});
