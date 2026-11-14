import { afterEach, expect, it, vi } from "vitest";
import { taskClient } from "./test-fixtures/task-client.js";
import { standIn } from "./testing/stand-in.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});
it("refreshes task activity and attention on the existing thread change topic without revoking a request", async () => {
  const stand = await standIn({ signup: "open" });
  cleanup.push(() => stand.close());
  stand.tasks.enabled = true;
  const email = "alex@example.com",
    other = "sam@example.com";
  const spaceId = stand.addTeam("Birch Studio", [email, other]);
  const projectId = stand.addProject(email, { name: "Canvas", fullName: "example/canvas" }, spaceId);
  const viewer = await taskClient(stand, other, { organization: true, execution: true, personal: false });
  cleanup.push(viewer.close);
  const task = stand.tasks.seed(spaceId, email, projectId);
  viewer.seen.pushes.length = 0;
  stand.addThread(email, { projectId, title: "Task progress", status: "working" });
  await vi.waitFor(() => expect(viewer.seen.pushes).toContainEqual({ type: "invalidate", keys: [`online-tasks:${spaceId}`] }));
  expect((await viewer.tasks.get({ spaceId, id: task.id })).task.id).toBe(task.id);
});
