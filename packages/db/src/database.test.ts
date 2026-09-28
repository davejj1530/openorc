import { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Db } from "./database.js";

vi.mock("sqlite-vec", async (importOriginal) => {
  const original = await importOriginal<typeof import("sqlite-vec")>();
  const getLoadablePath = vi.fn(original.getLoadablePath);
  return { ...original, getLoadablePath, load: (db: DatabaseSync) => db.loadExtension(getLoadablePath()) };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("native vector extension loading", () => {
  it.each([
    { name: "Electron macOS/Linux archive", electron: true, resolved: "/app/resources/app.asar/node_modules/vec0.dylib", physical: "/app/resources/app.asar.unpacked/node_modules/vec0.dylib" },
    { name: "ordinary Node directory named app.asar", electron: false, resolved: "/deps/app.asar/vec0.so", physical: "/deps/app.asar/vec0.so" },
  ])("keeps vector search available in a $name", ({ electron, resolved, physical }) => {
    const nativePath = vi.mocked(sqliteVec.getLoadablePath).getMockImplementation()!();
    const nativeLoad = DatabaseSync.prototype.loadExtension;
    vi.stubGlobal("process", { ...process, versions: { ...process.versions, electron: electron ? "44.3.0" : undefined } });
    vi.mocked(sqliteVec.getLoadablePath).mockReturnValueOnce(resolved);
    // SQLite's native loader only sees physical files, unlike Electron's JS fs API.
    vi.spyOn(DatabaseSync.prototype, "loadExtension").mockImplementation(function (this: DatabaseSync, file) {
      if (file !== physical) throw new Error("Native loader cannot open an archive path");
      nativeLoad.call(this, nativePath);
    });
    const db = Db.memory();
    try {
      expect(db.hasVectors).toBe(true);
      const embedding = Buffer.from(new Float32Array(384).buffer);
      db.stmt("INSERT INTO memory_vec (memory_rowid, embedding) VALUES (?, ?)").run(1n, embedding);
      expect(db.stmt("SELECT memory_rowid FROM memory_vec WHERE embedding MATCH ? AND k = 1").get(embedding)).toEqual({ memory_rowid: 1 });
    } finally {
      db.close();
    }
  });

  it("still opens a migrated database when the native extension is unavailable", () => {
    vi.spyOn(DatabaseSync.prototype, "loadExtension").mockImplementation(() => {
      throw new Error("Native extension unavailable");
    });
    const db = Db.memory();
    try {
      expect(db.hasVectors).toBe(false);
      expect(db.version).toBeGreaterThan(0);
      expect(db.stmt("SELECT count(*) AS count FROM memories").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });
});
