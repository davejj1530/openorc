import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { CloudBrainStatus, CloudProvider, CloudSignIns, CloudStatus } from "@openorc/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { CloudSettings } from "./settings-cloud";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
vi.mock("../components/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../components/ui")>()),
  Tooltip: ({ label, children }: { label: string; children: ReactNode }) => <span data-tooltip={label}>{children}</span>,
}));
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});

const status: CloudStatus = {
  vercel: { team: { id: "team_a", name: "Acme" }, project: "openorc-sandboxes", vcpus: null, region: "sin1" },
  claude: {},
  codex: { mode: null, email: null, plan: null, refreshedAt: null, signingIn: false, error: null },
  opencode: { providers: [] },
  check: null,
  takeover: false,
  error: null,
  service: "vercel",
};

const answers: Record<string, unknown> = {
  "cloud.status": status,
  "cloud.vercel.teams": [{ id: "team_a", name: "Acme" }],
  "claude.accounts.list": { accounts: [] },
  "cloud.brain.status": { state: "unavailable" },
  "cloud.sandboxes": [],
  "cloud.vercel.region": status,
  "cloud.offer": { offered: true, provider: "vercel" },
  "cloud.signIns": { rows: [], bringing: false },
};

it("shows the region new sandboxes run in, and sends a change", async () => {
  vi.mocked(core.call).mockImplementation(async (method: string) => answers[method] as never);
  render(
    <QueryClientProvider client={queryClient}>
      <CloudSettings active />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /^Connect a cloud service/ }));
  const region = screen.getByRole("combobox", { name: /^Sandbox region/ }) as HTMLSelectElement;
  expect(region.value).toBe("sin1");
  expect(region.selectedOptions[0]?.textContent).toBe("Singapore · sin1");
  fireEvent.change(region, { target: { value: "hnd1" } });
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.vercel.region", { region: "hnd1" }));
});

function showCloud(cloud: CloudStatus) {
  vi.mocked(core.call).mockImplementation(async (method: string) => (method === "cloud.status" ? cloud : answers[method]) as never);
  render(
    <QueryClientProvider client={queryClient}>
      <CloudSettings active />
    </QueryClientProvider>,
  );
}

it("asks for a token scoped to one team where Vercel is connected, with the reason on hover", async () => {
  window.openorc = { ...window.openorc, openExternal: vi.fn() };
  showCloud({ ...status, vercel: null, service: null });
  const scoped = await screen.findByText("scoped to one team");
  expect(scoped.getAttribute("data-tooltip")).toBe("Under Scope, choose the team, then All Projects. Whoever holds the token can change everything it reaches.");
  fireEvent.click(screen.getByRole("button", { name: "your Vercel account" }));
  expect(window.openorc.openExternal).toHaveBeenCalledWith("https://vercel.com/account/tokens");
});

it("says when the saved token reaches more than the chosen team, and nothing when it does not", async () => {
  showCloud({ ...status, vercel: { ...status.vercel!, reachesMore: true } });
  const line = await screen.findByText("This token reaches more than Acme.");
  expect(line.getAttribute("data-tooltip")).toBe("Whoever holds the token can change everything it reaches. Disconnect, then connect one scoped to Acme alone.");
  cleanup();
  queryClient.clear();
  showCloud(status);
  await screen.findByText("Connected");
  expect(screen.queryByText(/This token reaches more/)).toBeNull();
});

it("says once a Claude token is removed that it still works at Anthropic, and where to revoke it", async () => {
  window.openorc = { ...window.openorc, openExternal: vi.fn() };
  const account = { id: "claude-cli", name: "Personal", kind: "cli", enabled: true, status: "ready", email: "me@example.com", organization: null, message: null };
  const work = { ...account, id: "work", name: "Work", kind: "managed", email: "work@example.com" };
  let cloud: CloudStatus = { ...status, claude: { "claude-cli": { createdAt: 1, creating: false, error: null } } };
  vi.mocked(core.call).mockImplementation(async (method: string) => {
    if (method === "cloud.claude.remove") cloud = { ...cloud, claude: {} };
    if (method === "cloud.status") return cloud as never;
    if (method === "claude.accounts.list") return { accounts: [account, work], defaultId: "claude-cli" } as never;
    return answers[method] as never;
  });
  render(
    <QueryClientProvider client={queryClient}>
      <CloudSettings active />
    </QueryClientProvider>,
  );
  await screen.findByText("Ready");
  expect(screen.queryByText(/until you/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.claude.remove", { accountId: "claude-cli" }));
  await queryClient.invalidateQueries();
  const settings = await screen.findByRole("button", { name: "your Claude settings" });
  expect(screen.getAllByText(/until you revoke it/)).toHaveLength(1);
  expect(settings.closest("p")?.textContent).toBe("Removed from OpenOrc. It still works until you revoke it in your Claude settings, under Claude Code.");
  fireEvent.click(settings);
  expect(window.openorc.openExternal).toHaveBeenCalledWith("https://claude.ai/settings/claude-code");
});

it("shows the cloud brain once either service is connected, on Agent37 alone too, and not before", async () => {
  showCloud({ ...status, vercel: null, agent37: { size: { cpu: 2, memory: 4 } }, service: "agent37" });
  fireEvent.click(await screen.findByRole("button", { name: /^Set up the cloud brain/ }));
  expect(await screen.findByRole("button", { name: "Set up" })).toBeTruthy();
  cleanup();
  queryClient.clear();
  showCloud({ ...status, vercel: null, agent37: null, service: null });
  expect(await screen.findByText("Vercel")).toBeTruthy();
  expect((screen.getByRole("button", { name: /^Set up the cloud brain/ }) as HTMLButtonElement).disabled).toBe(true);
});

type Answers = { cloud: CloudStatus; place: CloudProvider | null; signIns?: CloudSignIns; brain?: CloudBrainStatus; more?: Record<string, unknown> };

function showSteps({ cloud, place, signIns = { rows: [], bringing: false }, brain = { state: "none", error: null }, more = {} }: Answers) {
  const by: Record<string, unknown> = { ...answers, ...more, "cloud.status": cloud, "cloud.offer": { offered: true, provider: place }, "cloud.signIns": signIns, "cloud.brain.status": brain };
  vi.mocked(core.call).mockImplementation(async (method: string) => by[method] as never);
  render(
    <QueryClientProvider client={queryClient}>
      <CloudSettings active />
    </QueryClientProvider>,
  );
}

const stepButton = (title: string) => screen.getByRole("button", { name: new RegExp(`^${title}`) });
const stepOf = (title: string) => stepButton(title).closest(".cloud-step") as HTMLElement;

it("starts with connecting a service, and holds the check and the cloud brain until one is", async () => {
  showSteps({ cloud: { ...status, vercel: null, service: null }, place: null });
  await screen.findByText("Vercel or Agent37. One is enough.");
  expect(stepButton("Connect a cloud service").getAttribute("aria-expanded")).toBe("true");
  expect(stepOf("Connect a cloud service").dataset.next).toBe("true");
  for (const title of ["Run the cloud check", "Set up the cloud brain"]) {
    expect((stepButton(title) as HTMLButtonElement).disabled).toBe(true);
    expect(within(stepOf(title)).getByText("Connect a cloud service first.")).toBeTruthy();
  }
  expect(screen.queryByText("When this Mac sleeps")).toBeNull();
  expect(screen.queryByText("Sandboxes")).toBeNull();
});

it("judges the check by where new threads run: a Vercel failure from before Agent37 was connected does not count", async () => {
  const steps = (["sandbox", "tools", "runner", "relay", "signins", "sync", "remove"] as const).map((step) => ({
    step,
    state: step === "sandbox" || step === "remove" ? ("failed" as const) : ("pending" as const),
    ms: 0,
    detail: null,
    error: step === "sandbox" || step === "remove" ? "Connect Vercel in Settings to run in the cloud." : null,
  }));
  const signIns: CloudSignIns = { rows: [{ kind: "claude", accountId: "claude-cli", label: "Personal", state: "ready", way: "browser", error: null }], bringing: false };
  showSteps({
    cloud: { ...status, vercel: null, agent37: { size: { cpu: 2, memory: 4 } }, service: "agent37", check: { provider: "vercel", passed: false, steps } },
    place: "agent37",
    signIns,
  });
  expect(await screen.findByText("Not run on Agent37 yet.")).toBeTruthy();
  expect(stepOf("Run the cloud check").dataset.state).toBe("todo");
  expect(stepButton("Run the cloud check").getAttribute("aria-expanded")).toBe("true");
  expect(screen.queryByText(/Connect Vercel/)).toBeNull();
  expect(within(stepOf("Connect a cloud service")).getByText("Agent37", { selector: ".cloud-step-summary" })).toBeTruthy();
  expect(within(stepOf("Sign in your agents")).getByText("Claude · Personal ready")).toBeTruthy();
});

it("keeps every sign-in in one step, the cloud brain's own Codex login and GitHub among them, counted once", async () => {
  const brainAnswers = {
    "cloud.brain.signIns": {
      codex: { mode: null, email: null, plan: null, signingIn: false, pending: null, error: null },
      github: { on: false, blocked: null, behind: false },
      push: { has: true, behind: false },
      memory: { has: false, behind: false },
    },
    "cloud.brain.phones": [],
    "cloud.brain.projects": [],
    "cloud.brain.cost": null,
  };
  showSteps({
    more: brainAnswers,
    cloud: { ...status, codex: { ...status.codex, mode: "chatgpt", email: "me@example.com", plan: "pro" } },
    place: "vercel",
    brain: { state: "ready", service: "vercel", region: "sin1", machine: "asleep", claude: ["Personal"], behind: false, working: null, door: null, threads: 0, error: null },
    signIns: {
      rows: [
        { kind: "claude", accountId: "claude-cli", label: "Personal", state: "ready", way: "browser", error: null },
        { kind: "codex", label: "Codex", state: "ready", way: "browser", error: null },
        { kind: "brain-codex", label: "Codex on the cloud brain", state: "missing", way: "browser", error: null },
        { kind: "github", label: "GitHub", state: "missing", way: "copy", error: null },
      ],
      bringing: false,
    },
  });
  expect(await screen.findByText("Claude · Personal, Codex ready · 2 not signed in")).toBeTruthy();
  fireEvent.click(stepButton("Sign in your agents"));
  const signIns = stepOf("Sign in your agents");
  expect(within(signIns).getByText("2 not signed in")).toBeTruthy();
  const codex = within(signIns).getByRole("heading", { name: "Codex" }).closest("section") as HTMLElement;
  expect(await within(codex).findByText("Cloud brain")).toBeTruthy();
  expect(within(codex).getByText("This Mac's cloud threads")).toBeTruthy();
  expect(within(signIns).getByRole("switch", { name: "GitHub" })).toBeTruthy();
  const brain = stepOf("Set up the cloud brain");
  expect(await within(brain).findByText("From this Mac")).toBeTruthy();
  expect(within(brain).queryByText("Cloud brain")).toBeNull();
  expect(within(brain).queryByRole("switch", { name: "GitHub", hidden: true })).toBeNull();
});

it("closes every step once cloud threads can run, each saying where it stands, and opens one on a click", async () => {
  const steps = (["sandbox", "tools", "runner", "relay", "signins", "sync", "remove"] as const).map((step) => ({ step, state: "done" as const, ms: 10, detail: null, error: null }));
  showSteps({
    cloud: { ...status, check: { provider: "vercel", passed: true, steps } },
    place: "vercel",
    signIns: {
      rows: [
        { kind: "claude", accountId: "claude-cli", label: "Personal", state: "ready", way: "browser", error: null },
        { kind: "codex", label: "Codex", state: "missing", way: "browser", error: null },
      ],
      bringing: false,
    },
  });
  expect(await screen.findByText("Passed on Vercel")).toBeTruthy();
  expect(screen.getByText("Vercel · Acme")).toBeTruthy();
  expect(screen.getByText("Claude · Personal ready · 1 not signed in")).toBeTruthy();
  for (const title of ["Connect a cloud service", "Sign in your agents", "Run the cloud check", "Set up the cloud brain"]) {
    expect(stepButton(title).getAttribute("aria-expanded")).toBe("false");
  }
  expect(screen.getByText("When this Mac sleeps")).toBeTruthy();
  fireEvent.click(stepButton("Run the cloud check"));
  expect(stepButton("Run the cloud check").getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("button", { name: "Run again" })).toBeTruthy();
});

it("names the step a failed check stopped at, where it ran", async () => {
  const states = ["done", "failed", "pending", "pending", "pending", "pending", "pending"] as const;
  const steps = (["sandbox", "tools", "runner", "relay", "signins", "sync", "remove"] as const).map((step, index) => ({
    step,
    state: states[index]!,
    ms: 10,
    detail: null,
    error: index === 1 ? "Claude Code is not installed in the sandbox." : null,
  }));
  showSteps({ cloud: { ...status, vercel: null, agent37: { size: { cpu: 2, memory: 4 } }, service: "agent37", check: { provider: "agent37", passed: false, steps } }, place: "agent37" });
  expect(await screen.findByText("Find Node, Git and Claude Code failed on Agent37.")).toBeTruthy();
  expect(stepOf("Run the cloud check").dataset.state).toBe("failed");
});
