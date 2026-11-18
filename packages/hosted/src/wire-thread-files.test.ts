import { expect, it } from "vitest";
import { THREAD_FILE_ROUTES, WireThreadFileNames, WireThreadFileRead, WireThreadFolder } from "./wire-thread-files.js";

it("asks the server for a thread's folder, a name search, a file and its bytes by the contract's paths", () => {
  expect(THREAD_FILE_ROUTES.list("t 1", "").path).toBe("/hosted/threads/t%201/files?path=");
  expect(THREAD_FILE_ROUTES.list("t1", "docs/guides & notes").path).toBe("/hosted/threads/t1/files?path=docs%2Fguides+%26+notes");
  expect(THREAD_FILE_ROUTES.search("t1", "plans", 50).path).toBe("/hosted/threads/t1/files/search?query=plans&limit=50");
  expect(THREAD_FILE_ROUTES.read("t1", "src/plans.ts").path).toBe("/hosted/threads/t1/files/read?path=src%2Fplans.ts");
  expect(THREAD_FILE_ROUTES.raw("t1", "assets/hero.png")).toBe("/hosted/threads/t1/files/raw?path=assets%2Fhero.png");
  for (const route of [THREAD_FILE_ROUTES.list("t1", ""), THREAD_FILE_ROUTES.search("t1", "a", 1), THREAD_FILE_ROUTES.read("t1", "a")]) expect(route.method).toBe("GET");
});

it("reads the contract's answers, whichever the server read them from, and its words where it cannot", () => {
  const saved = { from: "save", savedAt: "2026-11-18T07:00:00.000Z" };
  expect(WireThreadFolder.parse({ name: "launch", entries: [{ name: "docs", path: "docs", kind: "directory" }], source: saved }).entries).toHaveLength(1);
  expect(WireThreadFolder.parse({ name: "launch", entries: [], source: saved, unavailable: { message: "This thread has no files yet.", retry: false } }).unavailable?.retry).toBe(false);
  expect(WireThreadFileRead.parse({ kind: "file", text: "# Launch\n", size: 9, source: { from: "machine" } })).toMatchObject({ kind: "file", text: "# Launch\n" });
  expect(WireThreadFileRead.parse({ kind: "binary", media: "image", mime: "image/png", size: 2048, source: saved })).toMatchObject({ media: "image" });
  expect(WireThreadFileRead.parse({ kind: "unreadable", reason: "This file is too large to open (2 MB maximum).", source: saved })).toMatchObject({ kind: "unreadable" });
  expect(WireThreadFileRead.parse({ kind: "missing", source: saved }).kind).toBe("missing");
  expect(WireThreadFileNames.parse({ paths: ["notes/long.txt"], source: saved }).paths).toEqual(["notes/long.txt"]);
  expect(() => WireThreadFileRead.parse({ kind: "file", text: "x", size: 1 })).toThrow();
});
