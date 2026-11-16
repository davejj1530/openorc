import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Db, projects } from "@openorc/db";
import { afterEach, describe, expect, it } from "vitest";
import { parseDotEnv } from "../services/project-dot-env.js";
import { createHostedEnvironmentHandlers } from "./hosted-environment.js";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function projectWith(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "openorc-dot-env-"));
  folders.push(root);
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(root, name), text);
  const db = Db.memory();
  const project = projects.insert(db, { name: "api", rootPath: root, gitRemote: null, defaultBranch: "main", settings: {} });
  return { handlers: createHostedEnvironmentHandlers(null, db), project };
}

describe("a project's environment filled from this Mac", () => {
  it("reads .env and then .env.local, the later winning a name both set", async () => {
    const { handlers, project } = projectWith({ ".env": "DATABASE_URL=postgres://localhost/app\nAPP_MODE=dev\n", ".env.local": "APP_MODE=local\n" });
    expect(await handlers["hostedEnvironment.fromFile"]({ localProjectId: project.id })).toEqual({
      files: [".env", ".env.local"],
      entries: [
        { name: "DATABASE_URL", value: "postgres://localhost/app" },
        { name: "APP_MODE", value: "local" },
      ],
    });
  });

  it("finds nothing in a folder with no .env files", async () => {
    const { handlers, project } = projectWith({});
    expect(await handlers["hostedEnvironment.fromFile"]({ localProjectId: project.id })).toEqual({ files: [], entries: [] });
  });

  it("refuses a project this Mac doesn't have", () => {
    const { handlers } = projectWith({});
    expect(() => handlers["hostedEnvironment.fromFile"]({ localProjectId: "elsewhere" })).toThrow("That project isn't on this Mac.");
  });

  it("reads as unavailable without an account, and refuses a change in words", async () => {
    const { handlers } = projectWith({});
    expect(await handlers["hostedEnvironment.read"]({ spaceId: "s", projectId: "p" })).toEqual({ state: "unavailable" });
    expect(() => handlers["hostedEnvironment.set"]({ spaceId: "s", projectId: "p", variables: [{ name: "A", value: "b" }] })).toThrow("OpenOrc accounts aren't available here.");
  });
});

describe("a .env file's variables", () => {
  it("takes export, quotes, line breaks in double quotes and comments after unquoted values", () => {
    const text = ["# a comment", 'export TOKEN="a b"', "SINGLE='x # y'", 'LINES="one\\ntwo"', "PLAIN=value # note", "not a line", "EMPTY=", "1BAD=x"].join("\n");
    expect(parseDotEnv(text)).toEqual([
      { name: "TOKEN", value: "a b" },
      { name: "SINGLE", value: "x # y" },
      { name: "LINES", value: "one\ntwo" },
      { name: "PLAIN", value: "value" },
      { name: "EMPTY", value: "" },
    ]);
  });
});
