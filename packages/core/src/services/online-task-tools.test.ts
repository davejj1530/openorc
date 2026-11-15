import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { onlineToolsFixture } from "./test-fixtures/online-task-tools.js";

const fixtures: Awaited<ReturnType<typeof onlineToolsFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});
async function fixture(...args: Parameters<typeof onlineToolsFixture>) {
  const current = await onlineToolsFixture(...args);
  fixtures.push(current);
  return current;
}
const words = { title: "Keep the document", spec: "Save a shared task without starting work." };

it("creates backlog with an explicit destination and starts no local or cloud work", async () => {
  const { tools, scope, stand } = await fixture();
  const created = await tools.create("run-one", { ...words, scope, execution: "delegate" });
  expect(created).toMatchObject({ started: false, duplicate: false, task: { status: "backlog", taskRef: { place: "server", ...scope } } });
  const opened = await tools.start("run-one", created.task.id, scope);
  expect(opened).toMatchObject({ status: "backlog", message: "Open this task's cloud thread to start it.", taskRef: created.task.taskRef });
  expect(stand.started).toHaveLength(0);
  expect(stand.readies).toHaveLength(0);
});
it("uses the last observed revision and requires a read after conflict", async () => {
  const { tools, scope, client, seed } = await fixture();
  const task = seed();
  await tools.get("run-one", task.id, scope);
  await client.tasks.update({ spaceId: scope.spaceId, id: task.id, ifRevision: task.revision, requestId: randomUUID(), patch: { spec: "A teammate's saved words." } });
  await expect(tools.update("run-one", task.id, { scope, spec: "My draft words." })).rejects.toThrow("Read it again");
  await expect(tools.update("run-one", task.id, { scope, spec: "My draft words." })).rejects.toThrow("Read this task");
  expect((await client.tasks.get({ spaceId: scope.spaceId, id: task.id })).task.spec).toBe("A teammate's saved words.");
  await tools.get("run-one", task.id, scope);
  expect(await tools.update("run-one", task.id, { scope, spec: "My reviewed words." })).toMatchObject({ spec: "My reviewed words." });
});
it("replays a lost create reply with its original request id", async () => {
  let lose = true;
  const requests: string[] = [];
  const { tools, scope, stand } = await fixture({
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (String(url).endsWith("/tasks") && init?.method === "POST") {
        requests.push(String(init.body));
        if (lose && response.ok) {
          lose = false;
          await response.text();
          throw new TypeError("Lost reply");
        }
      }
      return response;
    },
  });
  await expect(tools.create("run-one", { ...words, scope })).rejects.toThrow("can't be reached");
  const retry = await tools.create("run-one", { ...words, scope });
  expect(requests).toHaveLength(2);
  expect(requests[0]).toBe(requests[1]);
  expect(stand.tasks.records.size).toBe(1);
  expect(retry.started).toBe(false);
});
it("rejects an unmapped project and never reads or edits another mapped project's task", async () => {
  const { tools, scope, seed, stand } = await fixture();
  const task = seed();
  const otherId = stand.addProject("person@example.com", { name: "Other", fullName: "example/other" }, scope.spaceId);
  const other = stand.tasks.seed(scope.spaceId, "person@example.com", otherId);
  await expect(tools.get("run-one", task.id, { ...scope, projectId: otherId })).rejects.toThrow("isn't available to this run");
  await expect(tools.get("run-one", other.id, scope)).rejects.toThrow("isn't in this run's project");
  await expect(tools.update("run-one", other.id, { scope, ifRevision: other.revision, spec: "Wrong target" })).rejects.toThrow("isn't in this run's project");
});
it.each(["account", "process", "project"] as const)("rejects %s replacement during project resolution before issuing a mutation", async (change) => {
  const { tools, scope, state, client, stand } = await fixture();
  const projects = client.hosted.spaces.projects.bind(client.hosted.spaces);
  vi.spyOn(client.hosted.spaces, "projects").mockImplementation(async (spaceId) => {
    const result = await projects(spaceId);
    if (change === "account") await client.session.end("person");
    if (change === "process") state.generation++;
    if (change === "project") state.project = "other-local-project";
    return result;
  });
  await expect(tools.create("run-one", { ...words, scope })).rejects.toThrow(/changed|session/);
  expect(stand.tasks.records.size).toBe(0);
});
it("uses online context only and preserves task status independently from activity", async () => {
  const { tools, scope, seed } = await fixture();
  const task = seed();
  task.status = "done";
  task.activity = { runId: "turn-one", state: "waiting", latestMessage: "Checking the export", lastAction: "Read source", waitingFor: "Choose the export destination", updatedAt: Date.now() };
  expect(await tools.context("run-one", scope)).toBe("No task context.");
  expect(await tools.context("run-one", scope, task.id)).toBe("No task context.");
  expect(await tools.get("run-one", task.id, scope)).toMatchObject({ status: "done", activity: { state: "waiting", waitingFor: "Choose the export destination" } });
  expect(await tools.list("run-one", scope)).toEqual([expect.objectContaining({ id: task.id, status: "done" })]);
});
it("keeps the paired execution gate closed", async () => {
  const { tools, scope } = await fixture({}, false);
  await expect(tools.list("run-one", scope)).rejects.toThrow("Online task tools aren't available");
});
it("offers the run's own cloud project as its scope, by name, and none while the server keeps task threads closed", async () => {
  const { tools, scope } = await fixture();
  expect(await tools.scopes("run-one")).toEqual([{ ...scope, name: expect.stringContaining("Example") }]);
  const closed = await fixture({}, false);
  expect(await closed.tools.scopes("run-one")).toEqual([]);
});
