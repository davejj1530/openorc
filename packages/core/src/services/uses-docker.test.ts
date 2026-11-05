import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "@openorc/git";
import { usesDocker } from "./uses-docker.js";

let repo: string;

beforeEach(async () => {
  repo = await realpath(await mkdtemp(path.join(os.tmpdir(), "openorc-uses-docker-")));
  await git(repo, ["init", "-q", "-b", "main"]);
  await put("README.md", "# Fixture\n");
  await commit();
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

async function put(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
  await writeFile(path.join(repo, file), content);
}

async function commit(): Promise<string> {
  await git(repo, ["add", "-A"]);
  await git(repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "Fixture"]);
  return (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
}

/** Whether a repository holding just `files`, committed, reads as running Docker. */
async function tracked(files: Record<string, string>): Promise<boolean> {
  for (const [file, content] of Object.entries(files)) await put(file, content);
  await commit();
  return usesDocker(repo);
}

describe("telling whether a project runs Docker", () => {
  it("does for a Compose file at the root or in a package", async () => {
    expect(await tracked({ "compose.yaml": "services:\n  db:\n    image: postgres:17\n" })).toBe(true);
    await rm(path.join(repo, "compose.yaml"));
    await put("services/api/docker-compose.yml", "services:\n  redis:\n    image: redis\n");
    await commit();
    expect(await usesDocker(repo)).toBe(true);
  });

  it.each([
    ["package.json", JSON.stringify({ devDependencies: { "@testcontainers/postgresql": "^11.0.0" } })],
    ["go.mod", "module example.com/app\n\nrequire github.com/testcontainers/testcontainers-go v0.38.0\n"],
    ["pom.xml", "<dependency><groupId>org.testcontainers</groupId><artifactId>postgresql</artifactId></dependency>\n"],
    ["build.gradle.kts", 'testImplementation("org.testcontainers:junit-jupiter:1.21.3")\n'],
    ["pyproject.toml", '[project]\ndependencies = ["testcontainers[postgres]>=4"]\n'],
    ["requirements-dev.txt", "pytest\ntestcontainers==4.10.0\n"],
    ["Gemfile", "gem 'testcontainers-postgres'\n"],
    ["Cargo.toml", '[dev-dependencies]\ntestcontainers = "0.25"\n'],
    ["composer.json", JSON.stringify({ "require-dev": { "testcontainers/testcontainers": "^1.0" } })],
    ["mix.exs", '{:testcontainers, "~> 1.13", only: [:test]}\n'],
  ])("does for a Testcontainers dependency in %s", async (file, content) => {
    expect(await tracked({ [`apps/api/${file}`]: content })).toBe(true);
  });

  it.each([
    ["package.json", JSON.stringify({ scripts: { "db:up": "docker compose up -d postgres" } })],
    ["Makefile", "test:\n\tdocker-compose -f ci.yml run tests\n"],
    ["justfile", "db:\n    docker run --rm -p 5432:5432 postgres\n"],
    ["Taskfile.yml", "tasks:\n  db:\n    cmds:\n      - docker   compose up -d\n"],
  ])("does for a Docker command in %s", async (file, content) => {
    expect(await tracked({ [file]: content })).toBe(true);
  });

  it("does not for a lone Dockerfile, which builds an image to deploy, or for words that only look like Docker", async () => {
    expect(
      await tracked({
        Dockerfile: "FROM node:24\nRUN npm ci\n",
        "package.json": JSON.stringify({ scripts: { build: "tsc", ship: "dockerize --run" }, keywords: ["docker"] }),
        Makefile: "image:\n\tdocker build -t app .\n",
      }),
    ).toBe(false);
  });

  it("does not for a sign deeper than a monorepo's packages, or inside dependencies kept in the repository", async () => {
    expect(await tracked({ "a/b/c/d/compose.yaml": "services: {}\n", "node_modules/pg/compose.yaml": "services: {}\n" })).toBe(false);
  });

  it("reads only tracked files", async () => {
    await put("compose.yaml", "services: {}\n");
    expect(await usesDocker(repo)).toBe(false);
  });

  it("reads a commit when given one, as before the worktree that starts there exists", async () => {
    const before = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
    await put("compose.yaml", "services: {}\n");
    const after = await commit();
    expect(await usesDocker(repo, before)).toBe(false);
    expect(await usesDocker(repo, after)).toBe(true);
  });
});
