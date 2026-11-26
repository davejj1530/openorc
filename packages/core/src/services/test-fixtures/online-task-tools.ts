import type { HostedDeps } from "@openorc/hosted";
import { standIn } from "@openorc/hosted/testing";
import { taskClient } from "../../../../hosted/src/test-fixtures/task-client.js";
import { OnlineTaskTools } from "../online-task-tools.js";

export async function onlineToolsFixture(overrides: Partial<HostedDeps> = {}, execution = true) {
  const stand = await standIn({ signup: "open" });
  stand.tasks.enabled = true;
  stand.threadFiles.capabilities = { tasks: execution ? { available: true } : { available: false, reason: "Task tools aren't available in cloud threads yet." }, board: { available: true } };
  const email = "person@example.com";
  const spaceId = stand.addTeam("Example Team", [email]);
  const projectId = stand.addProject(email, { name: "Example", fullName: "example/project" }, spaceId);
  const client = await taskClient(
    stand,
    email,
    { organization: true, personal: false },
    {
      projects: () => [{ id: "local-project", remote: "https://github.com/example/project" }],
      ...overrides,
    },
  );
  const account = { tasks: client.tasks, spaces: client.hosted.spaces };
  const state = { generation: 1, active: true, project: "local-project" };
  const tools = new OnlineTaskTools({
    account: () => account,
    projectFor: () => state.project,
    captureProcess: () => {
      const generation = state.generation;
      return () => state.active && state.generation === generation;
    },
  });
  return {
    stand,
    client,
    tools,
    state,
    scope: { spaceId, projectId },
    seed: () => stand.tasks.seed(spaceId, email, projectId, { title: "Preserve shared words", spec: "Keep every person's edits." }),
    async close() {
      client.close();
      await stand.close();
    },
  };
}
