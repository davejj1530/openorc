import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Project, Run, ThreadSummary } from "@openorc/protocol";
import { runs as runStore } from "../lib/client";
import { core } from "../lib/rpc";
import type { ComposerProps } from "./Composer";
import { Conversation } from "./Conversation";

const queries = vi.hoisted(() => new Map<string, unknown>());
const composer = vi.hoisted(() => ({ props: null as ComposerProps | null }));
vi.mock("../lib/rpc", () => ({
  core: new Proxy({ call: vi.fn() } as Record<string, unknown>, { get: (target, key: string) => (key in target ? target[key] : () => () => undefined) }),
}));
vi.mock("../lib/client", async (original) => ({
  ...(await original<object>()),
  useRpc: (method: string) => ({ data: queries.get(method), isLoading: false, isPending: false, isError: false, error: null, refetch: () => undefined }),
}));
vi.mock("./Composer", async (original) => ({
  ...(await original<object>()),
  Composer: (props: ComposerProps) => {
    composer.props = props;
    return props.notices;
  },
}));
vi.mock("./AgentOrb", () => ({ AgentOrb: () => null }));
Object.assign(globalThis, {
  IntersectionObserver: class {
    observe() {}
    disconnect() {}
  },
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
});

const project = { id: "project", name: "project", rootPath: "/tmp/project" } as Project;
const RUN = "hosted:cloud";
const thread = (overrides: Partial<ThreadSummary> = {}) =>
  ({
    id: "cloud",
    projectId: "project",
    title: "t",
    agent: "claude",
    model: "opus",
    effort: null,
    fastMode: false,
    mode: "act",
    permissionMode: "trusted",
    workspaceMode: "worktree",
    activity: "idle",
    session: { status: "idle", message: null },
    queued: [],
    hasStarted: true,
    owner: { brain: "hosted", reach: "live", heardAt: 1 },
    ...overrides,
  }) as unknown as ThreadSummary;

async function open(overrides: Partial<ThreadSummary> = {}) {
  queries.set("runs.listForThread", [
    { id: RUN, threadId: "cloud", taskId: null, agent: "claude", model: "opus", mode: "act", permissionMode: "trusted", state: "success", startedAt: 1, endedAt: 2 } as unknown as Run,
  ]);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Conversation scope={{ kind: "thread", thread: thread(overrides) }} project={project} />
    </QueryClientProvider>,
  );
  for (let i = 0; i < 6; i++) await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
  act(() => runStore.flush());
}

beforeEach(() => {
  runStore.reset();
  queries.clear();
  composer.props = null;
  vi.mocked(core.call).mockReset();
  vi.mocked(core.call).mockImplementation((async (method: string) => (method === "events.page" ? { events: [], fromTurn: 0, live: false } : undefined)) as never);
});
afterEach(cleanup);

it("offers no Fork on an OpenOrc Cloud thread, which would be refused there", async () => {
  await open();
  expect(composer.props!.commands?.map((command) => command.name)).not.toContain("fork");
});

it("still offers Fork on a thread of this Mac", async () => {
  await open({ owner: undefined });
  expect(composer.props!.commands?.map((command) => command.name)).toContain("fork");
});
