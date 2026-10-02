import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { WORKSPACE_ID, type Project, type ThreadSummary } from "@openorc/protocol";
import { Conversation } from "./Conversation";

const skills = vi.hoisted(() => ({ useSkillCommands: vi.fn(() => []) }));
vi.mock("../lib/skill-commands", () => skills);
vi.mock("../lib/rpc", () => ({
  core: new Proxy({ call: vi.fn() } as Record<string, unknown>, { get: (target, key: string) => (key in target ? target[key] : () => () => undefined) }),
}));
vi.mock("../lib/query", () => ({
  useRpc: () => ({ data: undefined, isLoading: false, isPending: false, isError: false, error: null, refetch: () => undefined }),
  useRpcMutation: () => ({ mutate: () => undefined, mutateAsync: async () => undefined, isPending: false, error: null }),
  invalidateTags: () => undefined,
}));
vi.mock("./Composer", async (original) => ({ ...(await original<object>()), Composer: () => null }));
vi.mock("./AgentOrb", () => ({ AgentOrb: () => null }));
afterEach(cleanup);

const workspace = { id: WORKSPACE_ID, name: "Workspace", rootPath: "/data/workspace" } as Project;
const conversation = (thread: Partial<ThreadSummary>, project: Project) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Conversation
        scope={{
          kind: "thread",
          thread: { id: "thread", title: "t", agent: "claude", model: "claude-fable-5-1", mode: "act", permissionMode: "review", activity: "idle", queued: [], ...thread } as ThreadSummary,
        }}
        project={project}
      />
    </QueryClientProvider>,
  );

it("asks for an Orcling's skills in the folder its own conversation works in", () => {
  conversation({ projectId: WORKSPACE_ID, orclingId: "rini", workingDirectory: "/data/orclings/rini" }, workspace);
  expect(skills.useSkillCommands).toHaveBeenLastCalledWith(WORKSPACE_ID, "claude", "/data/orclings/rini");
});

it("asks for a project conversation's skills from the project", () => {
  conversation({ projectId: "project", workspaceMode: "current" }, { id: "project", name: "Project", rootPath: "/code/project" } as Project);
  expect(skills.useSkillCommands).toHaveBeenLastCalledWith("project", "claude", undefined);
});
