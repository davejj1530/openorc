import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AccountStatus, Project, Run, ThreadSummary } from "@openorc/protocol";
import { useRouter } from "../lib/router";
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

const pro: AccountStatus = {
  state: "signed-in",
  email: "ada@example.com",
  name: "Ada Lovelace",
  image: null,
  reach: "live",
  plan: { pro: true, standing: "live", at: 0 },
  hours: { leftSeconds: 3600, monthly: { grantedSeconds: 3600, leftSeconds: 3600, resetsAt: 0 }, packsLeftSeconds: 0 },
  sandbox: null,
  signIns: [{ agent: "claude", provider: "anthropic", label: "Claude Max", ended: false }],
  signingIn: {},
  github: null,
  connectingGithub: null,
  projects: [],
  error: null,
};

async function open(overrides: Partial<ThreadSummary> = {}, account: AccountStatus = pro) {
  queries.set("account.status", account);
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

it("leaves out of a cloud thread's composer what OpenOrc Cloud does not take yet", async () => {
  await open();
  const props = composer.props!;
  expect(props.commands?.map((command) => command.name)).not.toContain("compact");
  expect(props.onCompact).toBeUndefined();
  expect(props.accounts).toBeUndefined();
  expect(props.attachmentsDisabledReason).toBe("Files can't be sent to OpenOrc Cloud yet.");
  expect(props.modelLimits).toEqual({ harnesses: ["claude", "codex", "opencode"], fast: false });
  expect(props.disabledReason).toBeNull();
  expect(screen.queryByRole("status", { name: "OpenOrc Cloud" })).toBeNull();
});

it.each([
  { name: "not Pro", account: { ...pro, plan: { pro: false as const }, hours: null }, words: "OpenOrc Cloud needs Pro.", action: "Upgrade", section: "account" },
  {
    name: "out of hours",
    account: { ...pro, hours: { leftSeconds: 0, monthly: { grantedSeconds: 3600, leftSeconds: 0, resetsAt: 0 }, packsLeftSeconds: 0 } },
    words: "You're out of cloud hours.",
    action: "Buy more hours",
    section: "account",
  },
  {
    name: "a payment not through",
    account: { ...pro, hours: { leftSeconds: 0, monthly: null, packsLeftSeconds: 0 } },
    words: "Your payment hasn't gone through.",
    action: "Billing",
    section: "account",
  },
  { name: "Claude not signed in", account: { ...pro, signIns: [] }, words: "Claude isn't signed in on OpenOrc Cloud.", action: "Sign in", section: "cloud" },
])("says above the composer when $name, disables Send with the same words, and leads on", async ({ account, words, action, section }) => {
  await open({}, account as AccountStatus);
  const card = screen.getByRole("status", { name: "OpenOrc Cloud" });
  expect(card.textContent).toContain(words);
  expect(composer.props!.disabledReason).toBe(words);
  fireEvent.click(screen.getByRole("button", { name: action }));
  expect(useRouter.getState().route).toMatchObject({ view: "settings", section });
});

it("lets a message into a running turn go whatever the hours, since the turn's starter pays", async () => {
  await open({ activity: "running" }, { ...pro, plan: { pro: false }, hours: null });
  expect(composer.props!.disabledReason).toBeNull();
});

it("makes the thread ready as the composer says the person is about to write, and not for a thread that cannot start a turn", async () => {
  await open();
  act(() => composer.props!.onReady!());
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("threads.ready", { id: "cloud", settings: expect.objectContaining({ agent: "claude", mode: "act", permissionMode: "trusted" }) }));
  cleanup();
  vi.mocked(core.call).mockClear();
  await open({}, { ...pro, plan: { pro: false }, hours: null });
  act(() => composer.props!.onReady!());
  await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
  expect(vi.mocked(core.call).mock.calls.map(([method]) => method)).not.toContain("threads.ready");
});

it("offers none of this Mac's skills or connectors in a cloud thread, which runs elsewhere", async () => {
  const skill = { name: "review-pr", description: "Review a pull request", source: "user", enabled: true };
  const answers: Record<string, unknown> = { "events.page": { events: [], fromTurn: 0, live: false }, "skills.list": [skill] };
  vi.mocked(core.call).mockImplementation((async (method: string) => answers[method]) as never);
  await open({ owner: undefined });
  await waitFor(() => expect(composer.props!.commands?.map((command) => command.name)).toContain("review-pr"));
  cleanup();
  await open();
  expect(composer.props!.commands?.map((command) => command.name)).not.toContain("review-pr");
  expect(composer.props!.connectors).toEqual([]);
});

it("says a refused send once, on the card above the composer", async () => {
  const noHours = { ...pro, hours: { leftSeconds: 0, monthly: { grantedSeconds: 3600, leftSeconds: 0, resetsAt: 0 }, packsLeftSeconds: 0 } };
  await open();
  vi.mocked(core.call).mockImplementation((async (method: string) => {
    if (method === "events.page") return { events: [], fromTurn: 0, live: false };
    if (method !== "runs.start") return undefined;
    queries.set("account.status", noHours);
    throw new Error("You're out of cloud hours.");
  }) as never);
  await act(async () => void (await composer.props!.onSubmit("Run the export", [], false).catch(() => undefined)));
  await waitFor(() => expect(screen.getByRole("status", { name: "OpenOrc Cloud" }).textContent).toContain("You're out of cloud hours."));
  expect(composer.props!.error).toBeUndefined();
});

it("sends rather than queues on a thread whose ask outlived its turn, since nothing runs", async () => {
  await open({ activity: "waiting" });
  expect(composer.props!.queueing).toBe(false);
  expect(composer.props!.live).toBeNull();
  expect(composer.props!.placeholder).toBe("Message Claude…");
});
