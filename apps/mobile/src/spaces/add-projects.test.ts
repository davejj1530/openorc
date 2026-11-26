import { expect, it, vi } from "vitest";
import type { OrganizationAccess, Space } from "@openorc/protocol";
import type { PhoneSpaces } from "./use-spaces";

vi.mock("../cloud/use-own-cloud", () => ({ useOwnCloud: () => false }));
vi.mock("../client", () => ({ useRpc: () => ({ data: undefined }) }));
vi.mock("../connection/use-shares", () => ({ useShares: () => null }));
vi.mock("./space-choice", () => ({ useChosenSpace: () => null }));

const { addedChoice, addLabel, projectAdding, repositoryRows } = await import("./add-projects");

const personal = { id: "personal-me", kind: "personal" } as const;
const birch = { id: "org-birch", kind: "organization", name: "Birch Studio", logo: null, memberId: "m", memberCount: 3 } as const;
const ready = (current: Space, access: OrganizationAccess | null = null): PhoneSpaces => ({ state: "ready", spaces: [personal, current], current, access, offline: false, userId: "u-me" });

it("lets a phone add projects only through its own cloud session: to the person's own space, or an organization they administer and may work in", () => {
  expect(projectAdding(true, ready(personal), 0)).toBe("personal-me");
  expect(projectAdding(true, ready({ ...birch, role: "admin" }), 0)).toBe("org-birch");
  expect(projectAdding(true, ready({ ...birch, role: "member" }), 0)).toBeNull();
  expect(projectAdding(false, ready(personal), 0)).toBeNull();
  expect(projectAdding(true, { state: "none" }, 0)).toBeNull();
  expect(projectAdding(true, ready({ ...birch, role: "admin" }, { state: "frozen", reason: "no_pro", until: null, message: "Frozen" }), 0)).toBeNull();
});

const repo = (repoId: number, fullName: string, projectId: string | null = null) => ({ installationId: "one", repoId, fullName, defaultBranch: "main", private: true, projectId });

it("lists a space's repositories by name, each as added, ticked or open, with why the last try at one was refused", () => {
  const repositories = [repo(1, "example/canvas", "p-1"), repo(2, "example/tools"), repo(3, "example/site"), repo(4, "example/docs")];
  const rows = repositoryRows(
    repositories,
    "",
    ["one:2", "one:3", "one:4"],
    [
      { installationId: "one", repoId: 3, state: "added", projectId: "p-3" },
      { installationId: "one", repoId: 4, state: "refused", error: "OpenOrc can't read that repository." },
    ],
  );
  expect(rows.map((row) => [row.name, row.state, row.error])).toEqual([
    ["canvas", "added", null],
    ["tools", "chosen", null],
    ["site", "added", null],
    ["docs", "chosen", "OpenOrc can't read that repository."],
  ]);
  expect(repositoryRows(repositories, " TOOL ", [], []).map((row) => row.name)).toEqual(["tools"]);
});

it("names the button for how many it adds", () => {
  expect([addLabel(0), addLabel(1), addLabel(3)]).toEqual(["Add project", "Add project", "Add 3 projects"]);
});

it("names an added project as New thread chooses it: by the Mac's folder where it has one, else by its cloud key", () => {
  const project = (key: string, hostedProjectId: string, localProjectId: string | null) => ({ key, name: key, repo: null, localProjectId, hostedProjectId }) as never;
  const projects = [project("openorc-cloud:p-1", "p-1", null), project("openorc-cloud:p-2", "p-2", "mac-tools")];
  const added = (repoId: number, projectId: string) => ({ installationId: "one", repoId, state: "added", projectId }) as const;
  expect(addedChoice(projects, [added(1, "p-1"), added(2, "p-2")])).toBe("openorc-cloud:p-1");
  expect(addedChoice(projects, [added(2, "p-2")])).toBe("mac-tools");
  expect(addedChoice(projects, [added(3, "p-3")])).toBeNull();
  expect(addedChoice(undefined, [added(1, "p-1")])).toBeNull();
});
