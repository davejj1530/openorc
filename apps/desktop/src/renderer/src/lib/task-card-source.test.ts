import { expect, it } from "vitest";
import type { HostedFileScope } from "@openorc/protocol";
import { taskCardSource } from "./task-card-source";
import { taskAccess } from "./test-fixtures/task-access";

const id = "task-one";
const scope: HostedFileScope = { accountId: "account-a", apiOrigin: "https://example.com", spaceId: "org:studio", destination: { kind: "hosted", projectId: "project-one", threadId: "thread-one" } };
const reference = { place: "server" as const, spaceId: scope.spaceId, projectId: "project-one", id };
it("keeps a bare Mac id local and a bare cloud id in its captured project", () => {
  expect(taskCardSource(id, { kind: "none" }, false, null, undefined)).toEqual({ kind: "local" });
  expect(taskCardSource(id, { kind: "none" }, true, scope, taskAccess())).toEqual({
    kind: "online",
    reference: { kind: "online", accountId: "account-a", spaceId: scope.spaceId, projectId: "project-one", id },
  });
});
it("never falls through to Mac while hosted identity or a tool reference is unavailable", () => {
  expect(taskCardSource(id, { kind: "none" }, true, null, taskAccess())).toEqual({ kind: "unavailable" });
  expect(taskCardSource(id, { kind: "unavailable" }, false, null, taskAccess())).toEqual({ kind: "unavailable" });
  expect(taskCardSource(id, { kind: "online", reference }, false, null, { state: "signed-out" })).toEqual({ kind: "unavailable" });
});
it("allows an explicit local-agent reference only in a currently readable account space", () => {
  expect(taskCardSource(id, { kind: "online", reference }, false, null, taskAccess()).kind).toBe("online");
  expect(taskCardSource(id, { kind: "online", reference: { ...reference, spaceId: "org:another" } }, false, null, taskAccess()).kind).toBe("unavailable");
});
it("refuses account, space and project mismatches in a cloud tool result", () => {
  for (const captured of [
    { ...scope, accountId: "another-account" },
    { ...scope, spaceId: "org:another" },
    { ...scope, destination: { kind: "hosted" as const, projectId: "another-project", threadId: "thread-one" } },
  ]) {
    expect(taskCardSource(id, { kind: "online", reference }, true, captured, taskAccess()).kind).toBe("unavailable");
  }
});
