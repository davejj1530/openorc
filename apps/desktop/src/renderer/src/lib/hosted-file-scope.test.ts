// @vitest-environment jsdom
import { expect, it } from "vitest";
import type { SpaceProject, SpacesStatus } from "@openorc/protocol";
import { hostedFileScope } from "./hosted-file-scope";

const status: SpacesStatus = {
  state: "ready",
  userId: "person",
  apiOrigin: "https://api.example.com",
  personalSpaceId: "personal",
  spaces: [{ kind: "personal", id: "personal" }],
  create: { allowed: true, reason: null },
  invitations: [],
  reach: "live",
  heardAt: 1,
  error: null,
};
const projects: SpaceProject[] = [{ key: "shown", localProjectId: "local", hostedProjectId: "server", name: "example", repo: "sample/example", connected: true }];
const input = { status, projects, spaceId: "personal", projectId: "shown", threadId: "thread" };

it("captures canonical hosted IDs for every project presentation", () => {
  for (const projectId of ["shown", "local", "server"])
    expect(hostedFileScope({ ...input, projectId })).toEqual({
      accountId: "person",
      apiOrigin: "https://api.example.com",
      spaceId: "personal",
      destination: { kind: "hosted", projectId: "server", threadId: "thread" },
    });
});

it("does not borrow a previous account's destination or pretend an unknown project is ready", () => {
  expect(hostedFileScope({ ...input, selectedAccount: "other" })).toBeNull();
  expect(hostedFileScope({ ...input, projectId: "unknown" })).toBeNull();
  expect(hostedFileScope({ ...input, projects: undefined })).toBeNull();
  expect(hostedFileScope({ ...input, spaceId: "other" })).toBeNull();
  expect(hostedFileScope({ ...input, status: { state: "signed-out" } })).toBeNull();
});
