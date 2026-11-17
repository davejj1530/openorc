import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AccountStatus, Project, Run, SpaceProject, SpacesStatus, ThreadSummary } from "@openorc/protocol";
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
  paying: null,
  projects: [],
  error: null,
};

const spaces: SpacesStatus = {
  state: "ready",
  userId: "ada",
  apiOrigin: "https://api.example.com",
  personalSpaceId: "personal",
  spaces: [{ kind: "personal", id: "personal" }],
  create: { allowed: true, reason: null },
  invitations: [],
  reach: "live",
  heardAt: 1,
  error: null,
};
const catalog: SpaceProject[] = [{ key: "project", localProjectId: "project", hostedProjectId: "server-project", name: "project", repo: "sample/project", connected: true }];

async function open(overrides: Partial<ThreadSummary> = {}, account: AccountStatus = pro, status: SpacesStatus = spaces) {
  queries.set("account.status", account);
  queries.set("spaces.status", status);
  queries.set("spaces.projects", catalog);
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

it("offers Compact in a cloud thread only once its server serves it", async () => {
  queries.set("hosted.capabilities", { version: 1, features: {} });
  await open();
  expect(composer.props!.commands?.map((command) => command.name)).not.toContain("compact");
  expect(composer.props!.onCompact).toBeUndefined();
  cleanup();
  queries.set("hosted.capabilities", { version: 1, features: { compact: { available: true } } });
  await open();
  await waitFor(() => expect(composer.props!.commands?.map((command) => command.name)).toContain("compact"));
  expect(composer.props!.onCompact).toBeTypeOf("function");
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
    action: "Update payment",
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

it("offers the person's own skills in a cloud thread once the server gives its turns them, and never this Mac's project's or connectors", async () => {
  const own = { name: "review-pr", description: "Review a pull request", source: "user", enabled: true };
  const off = { name: "ship-it", description: "Ship", source: "user", enabled: false };
  const projects = { name: "deploy", description: "Deploy this project", source: "project", enabled: true };
  const asked: unknown[] = [];
  vi.mocked(core.call).mockImplementation((async (method: string, params: unknown) => {
    if (method === "skills.list") asked.push(params);
    return method === "skills.list" ? [own, off, projects] : { events: [], fromTurn: 0, live: false };
  }) as never);
  queries.set("hosted.capabilities", { version: 1, features: { skills: { available: false, reason: "Your skills aren't available in cloud threads yet." } } });
  await open();
  expect(composer.props!.commands?.map((command) => command.name)).not.toContain("review-pr");
  expect(asked).toEqual([]);
  cleanup();
  queries.set("hosted.capabilities", { version: 1, features: { skills: { available: true } } });
  await open();
  await waitFor(() => expect(composer.props!.commands?.map((command) => command.name)).toContain("review-pr"));
  const names = composer.props!.commands?.map((command) => command.name);
  expect(names).not.toContain("deploy");
  expect(names).not.toContain("ship-it");
  // They are read where no project's skills are: the Workspace, never the cloud thread's project on this Mac.
  expect(asked).toEqual([{ scope: { kind: "project", id: "openorc-workspace" }, agent: "claude" }]);
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

it("keeps a teammate's composer honest even when the reader lacks cloud hours", async () => {
  await open({ owner: { brain: "hosted", reach: "live", heardAt: 1, startedBy: { name: "Morgan Reed", image: null } } }, { ...pro, plan: { pro: false }, hours: null });
  expect(composer.props!.disabledReason).toBe("Only Morgan can make changes in Morgan's thread.");
  expect(composer.props!.readOnlyReason).toBe("Only Morgan can make changes in Morgan's thread.");
  expect(composer.props!.placeholder).toBe("Morgan's thread");
  expect(screen.queryByRole("status", { name: "OpenOrc Cloud" })).toBeNull();
  act(() => composer.props!.onReady!());
  await act(async () => undefined);
  expect(vi.mocked(core.call).mock.calls.map(([method]) => method)).not.toContain("threads.ready");
});

it.each([
  { owner: undefined, label: "Needs you" },
  { owner: { brain: "hosted", reach: "live", heardAt: 1 }, label: "Needs you" },
  { owner: { brain: "hosted", reach: "live", heardAt: 1, startedBy: { name: "Morgan Reed", image: null } }, label: "Waiting on Morgan" },
] satisfies { owner: ThreadSummary["owner"]; label: string }[])("gives the ask dock the header's waiting words: $label", async ({ owner, label }) => {
  await open({ activity: "waiting", owner });
  expect(composer.props!.asksLabel).toBe(label);
});

it("blocks sending to a thread out of reach even if the account is online", async () => {
  await open({ owner: { brain: "hosted", reach: "offline", heardAt: 1 } });
  expect(composer.props!.disabledReason).toMatch(/can't be reached/);
  expect(composer.props!.readOnlyReason).toBeNull();
  expect(screen.queryByRole("status", { name: "OpenOrc Cloud" })).toBeNull();
});

it.each([undefined, { brain: "hosted", reach: "live", heardAt: 1 }] satisfies ThreadSummary["owner"][])("keeps sending available on one's own reachable thread (%j)", async (owner) => {
  await open({ owner });
  expect(composer.props!.disabledReason).toBeNull();
  expect(composer.props!.readOnlyReason).toBeNull();
  expect(composer.props!.placeholder).toBe("Message Claude…");
});

it("keeps a cloud thread's unsent words and files to the signed-in person and space", async () => {
  await open();
  expect(composer.props!.draftKey).toContain("ada");
  expect(composer.props!.draftKey).toContain("personal");
  expect(composer.props!.hostedFiles).toEqual({
    accountId: "ada",
    apiOrigin: "https://api.example.com",
    spaceId: "personal",
    destination: { kind: "hosted", projectId: "server-project", threadId: "cloud" },
  });
});

it("says so when the account server can't be reached, rather than showing an empty thread", async () => {
  await open({}, pro, { state: "loading", error: "OpenOrc Cloud can't be reached." });
  expect(composer.props).toBeNull();
  expect(screen.getByText("OpenOrc Cloud can't be reached.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
});

it("sends a cloud message with files once under one id, again under the same id after a failure, and the next message under a new one", async () => {
  await open();
  const sent: Record<string, unknown>[] = [];
  let failing = true;
  vi.mocked(core.call).mockImplementation((async (method: string, params: Record<string, unknown>) => {
    if (method === "events.page") return { events: [], fromTurn: 0, live: false };
    if (method !== "runs.start") return undefined;
    sent.push(params);
    if (failing) throw new Error("Your OpenOrc session changed. Try again.");
    return { id: RUN };
  }) as never);
  const files = ["/hosted/files/f1/notes.txt", "/hosted/files/f2/plan.md"];
  await act(async () => void (await composer.props!.onSubmit("Read these", files, false).catch(() => undefined)));
  failing = false;
  await act(async () => void (await composer.props!.onSubmit("Read these", files, false)));
  await act(async () => void (await composer.props!.onSubmit("Read these", files, false)));
  expect(sent.map((params) => params["attachments"])).toEqual([files, files, files]);
  expect(sent[0]!["messageId"]).toMatch(/^[0-9a-f-]{36}$/);
  expect(sent[1]!["messageId"]).toBe(sent[0]!["messageId"]);
  expect(sent[2]!["messageId"]).not.toBe(sent[0]!["messageId"]);
});
