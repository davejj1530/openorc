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
  const viewer = await taskClient(stand, other, { organization: true, personal: false });
  cleanup.push(viewer.close);
  const task = stand.tasks.seed(spaceId, email, projectId);
  viewer.seen.pushes.length = 0;
  stand.addThread(email, { projectId, title: "Task progress", status: "working" });
  await vi.waitFor(() => expect(viewer.seen.pushes).toContainEqual({ type: "invalidate", keys: [`online-tasks:${spaceId}`] }));
  expect((await viewer.tasks.get({ spaceId, id: task.id })).task.id).toBe(task.id);
});

it.each([false, true])("refreshes Personal task reads only when that delivery is enabled (%s)", async (personal) => {
  const stand = await standIn({ signup: "open" });
  cleanup.push(() => stand.close());
  const email = "person@example.com";
  const projectId = stand.addProject(email, { name: "Example", fullName: "example/project" });
  const viewer = await taskClient(stand, email, { organization: true, personal });
  cleanup.push(viewer.close);
  const status = viewer.hosted.spaces.status();
  if (status.state !== "ready") throw new Error("The account isn't ready.");
  viewer.seen.pushes.length = 0;
  const thread = stand.addThread(email, { projectId, title: "Progress", status: "working" });
  await vi.waitFor(() => expect(viewer.hosted.threads.holds({ thread })).toBe(true));
  const expected = { type: "invalidate", keys: [`online-tasks:${status.personalSpaceId}`] };
  if (personal) expect(viewer.seen.pushes).toContainEqual(expected);
  else expect(viewer.seen.pushes).not.toContainEqual(expected);
});
