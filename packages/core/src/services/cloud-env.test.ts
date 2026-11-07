import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloudProjectEnv, cloudEnvNameProblem, handedEnv, parseDotEnv, projectDotEnv } from "./cloud-env.js";

function memoryStore(initial: string | null = null) {
  const store = { value: initial, saves: 0, load: async () => store.value, save: async (value: string) => void ((store.value = value), store.saves++) };
  return store;
}

describe("a project's cloud variable names", () => {
  it("takes a plain variable name", () => {
    expect(cloudEnvNameProblem("DATABASE_URL")).toBeNull();
    expect(cloudEnvNameProblem("_private2")).toBeNull();
  });

  it("refuses what is no variable name, what the sandbox sets, and names that choose an agent's sign-in", () => {
    expect(cloudEnvNameProblem("1PASSWORD")).toMatch(/not a variable name/);
    expect(cloudEnvNameProblem("MY-KEY")).toMatch(/not a variable name/);
    expect(cloudEnvNameProblem("PATH")).toBe("PATH is set by the sandbox for every turn.");
    expect(cloudEnvNameProblem("HOME")).toBe("HOME is set by the sandbox for every turn.");
    for (const name of ["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "OPENAI_API_KEY", "CODEX_HOME", "OPENCODE_CONFIG", "OPENORC_CLOUD"]) {
      expect(cloudEnvNameProblem(name)).toMatch(/choose the agent's own sign-in/);
    }
  });
});

describe("reading a .env file", () => {
  it("takes KEY=value lines, with export, quotes, comments and escaped line breaks", () => {
    const text = [
      "# a comment",
      "",
      "PLAIN=value",
      "export EXPORTED=yes",
      'DOUBLE="two words"',
      "SINGLE='keeps \\n as is'",
      'LINES="one\\ntwo"',
      "COMMENTED=kept # dropped",
      "HASH=a#b",
      "SPACED = padded ",
      "not a line",
      "PLAIN=later wins",
    ].join("\n");
    expect(parseDotEnv(text)).toEqual([
      { name: "PLAIN", value: "later wins" },
      { name: "EXPORTED", value: "yes" },
      { name: "DOUBLE", value: "two words" },
      { name: "SINGLE", value: "keeps \\n as is" },
      { name: "LINES", value: "one\ntwo" },
      { name: "COMMENTED", value: "kept" },
      { name: "HASH", value: "a#b" },
      { name: "SPACED", value: "padded" },
    ]);
  });

  describe("from a project", () => {
    let dir: string;
    afterEach(async () => rm(dir, { recursive: true, force: true }));

    it("reads .env then .env.local, the later winning a name both set, and says which it read", async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), "openorc-dotenv-"));
      await writeFile(path.join(dir, ".env"), "A=from-env\nB=only-env\n");
      await writeFile(path.join(dir, ".env.local"), "A=from-local\n");
      expect(await projectDotEnv(dir)).toEqual({
        files: [".env", ".env.local"],
        entries: [
          { name: "A", value: "from-local" },
          { name: "B", value: "only-env" },
        ],
      });
    });

    it("finds nothing in a project without one", async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), "openorc-dotenv-"));
      expect(await projectDotEnv(dir)).toEqual({ files: [], entries: [] });
    });
  });
});

describe("each project's cloud environment", () => {
  it("keeps values in protected storage and shows only names", async () => {
    const store = memoryStore();
    let changes = 0;
    const env = new CloudProjectEnv(store, () => changes++);
    expect(
      await env.set("p1", [
        { name: "Z_KEY", value: "z" },
        { name: "API_URL", value: "https://dev.example" },
      ]),
    ).toEqual(["API_URL", "Z_KEY"]);
    expect(await env.names("p1")).toEqual(["API_URL", "Z_KEY"]);
    expect(await env.vars("p1")).toEqual({ Z_KEY: "z", API_URL: "https://dev.example" });
    expect(JSON.parse(store.value!)).toEqual({ p1: { Z_KEY: "z", API_URL: "https://dev.example" } });
    expect(changes).toBe(1);
    // Read again from storage, as after a restart.
    expect(await new CloudProjectEnv(store).vars("p1")).toEqual({ Z_KEY: "z", API_URL: "https://dev.example" });
  });

  it("keeps a saved value for a row without one, and removes a name left out", async () => {
    const env = new CloudProjectEnv(memoryStore());
    await env.set("p1", [
      { name: "KEEP", value: "secret" },
      { name: "GONE", value: "x" },
    ]);
    expect(await env.set("p1", [{ name: "KEEP" }, { name: "NEW", value: "n" }])).toEqual(["KEEP", "NEW"]);
    expect(await env.vars("p1")).toEqual({ KEEP: "secret", NEW: "n" });
  });

  it("refuses, changing nothing, a name it cannot set, one set twice, a new one without a value, or too much", async () => {
    const store = memoryStore();
    const env = new CloudProjectEnv(store);
    await env.set("p1", [{ name: "A", value: "1" }]);
    const saves = store.saves;
    await expect(env.set("p1", [{ name: "PATH", value: "/bin" }])).rejects.toThrow("PATH is set by the sandbox for every turn.");
    await expect(
      env.set("p1", [
        { name: "A", value: "1" },
        { name: "A", value: "2" },
      ]),
    ).rejects.toThrow("A is set twice.");
    await expect(env.set("p1", [{ name: "B" }])).rejects.toThrow("Enter a value for B.");
    await expect(env.set("p1", [{ name: "BIG", value: "x".repeat(70 * 1024) }])).rejects.toThrow(/too large for a cloud turn/);
    expect(store.saves).toBe(saves);
    expect(await env.vars("p1")).toEqual({ A: "1" });
  });

  it("refuses what would make every project's variables together too large to hand to the cloud brain", async () => {
    const env = new CloudProjectEnv(memoryStore());
    const half = (name: string) => ({ name, value: "x".repeat(30_000) });
    for (const project of ["p1", "p2", "p3", "p4"]) await env.set(project, [half("A"), half("B")]);
    await expect(env.set("p5", [half("A"), half("B")])).rejects.toThrow(/together are too large/);
    expect(await env.names("p5")).toEqual([]);
  });

  it("drops a project whose variables are all removed", async () => {
    const store = memoryStore();
    const env = new CloudProjectEnv(store);
    await env.set("p1", [{ name: "A", value: "1" }]);
    await env.set("p1", []);
    expect(JSON.parse(store.value!)).toEqual({});
  });

  it("says why when protected storage cannot be read", async () => {
    const env = new CloudProjectEnv({ load: async () => Promise.reject(new Error("locked")), save: async () => undefined });
    await expect(env.names("p1")).rejects.toThrow(/Cannot access protected storage/);
  });

  it("on a cloud brain, takes exactly what its Mac handed over", async () => {
    const env = new CloudProjectEnv(memoryStore(JSON.stringify({ old: { X: "1" } })));
    await env.adopt([{ source: "mac-p1", vars: { A: "1" } }]);
    expect(await env.all()).toEqual([{ source: "mac-p1", vars: { A: "1" } }]);
    expect(await env.vars("old")).toEqual({});
  });
});

describe("the projects' environments as a cloud brain is handed them", () => {
  it("are in one order whatever order they were set in, without projects that have none", () => {
    expect(
      handedEnv([
        { source: "b", vars: { Z: "1", A: "2" } },
        { source: "empty", vars: {} },
        { source: "a", vars: { M: "3" } },
      ]),
    ).toEqual([
      { source: "a", vars: [{ name: "M", value: "3" }] },
      {
        source: "b",
        vars: [
          { name: "A", value: "2" },
          { name: "Z", value: "1" },
        ],
      },
    ]);
  });
});
