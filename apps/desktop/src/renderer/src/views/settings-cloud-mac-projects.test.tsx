import type { BringResult, BringState, MacProjects } from "@openorc/protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { useHostedBring } from "../panels/HostedBring";
import { SpaceCloudProjects } from "./settings-cloud-projects";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
vi.mock("../lib/browser-preview", () => ({ CoversPreview: () => null }));

let mac: MacProjects;
let bringState: BringState;
let bringAnswers: BringResult[];
let answers: Record<string, unknown>;

beforeEach(() => {
  mac = {
    state: "ready",
    personalSpaceId: "personal",
    projects: [
      { hostedProjectId: "m1", name: "sketches", localProjectId: "l1", folder: "/Users/ana/dev/clients/northwind/sketches-for-the-spring-launch", sending: { at: "sent" } },
      { hostedProjectId: "m2", name: "recipes", localProjectId: "l2", folder: "/Users/ana/dev/recipes", sending: { at: "sending", sent: 12 * 1024 * 1024, total: 40 * 1024 * 1024 } },
      { hostedProjectId: "m3", name: "notes", localProjectId: "l3", folder: "/Users/ana/notes", sending: { at: "failed", error: "The connection was lost." } },
    ],
    folders: [{ localProjectId: "l4", name: "drafts", folder: "/Users/ana/drafts" }],
  };
  bringState = { mac: true, can: true, ends: [] };
  bringAnswers = [];
  answers = {
    "spaces.projects": [],
    "hostedEnvironment.available": true,
    "account.status": { state: "signed-in", projects: [] },
    "organization.repositories": { configured: true, installations: [], connecting: null, repositories: [] },
    "macProjects.unbrought": { threads: 2 },
  };
  vi.mocked(core.call).mockImplementation((async (method: string) => {
    if (method === "macProjects.read" || method === "macProjects.add" || method === "macProjects.retry" || method === "macProjects.cancel") return mac;
    if (method === "macProjects.bringState") return bringState;
    if (method === "macProjects.bring") return bringAnswers.shift();
    return answers[method] ?? null;
  }) as never);
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});

const show = () => render(<QueryClientProvider client={queryClient}>{<SpaceCloudProjects spaceId="personal" title="Personal projects" personal active />}</QueryClientProvider>);

it("shows each mac project by where it came from, its history on its way with Cancel, or why it didn't arrive with Send again", async () => {
  show();
  expect(await screen.findByText((_, element) => element?.textContent === "No remote · ~/dev/clients/northwind/sketches-for-the-spring-launch" && element.children.length > 1)).toBeTruthy();
  expect(screen.getByText("12 MB of 40 MB")).toBeTruthy();
  expect(screen.getByText("Couldn't send: The connection was lost.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Send again" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("macProjects.retry", { hostedProjectId: "m3" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("macProjects.cancel", { hostedProjectId: "m2" }));
});

it("asks before a mac project goes, counting the threads whose work never came to this Mac", async () => {
  show();
  fireEvent.click((await screen.findAllByRole("button", { name: "Remove" }))[0]!);
  const sheet = await screen.findByRole("dialog");
  expect(within(sheet).getByText("Remove sketches from the cloud?")).toBeTruthy();
  expect(await within(sheet).findByText("2 threads have work that never came to this Mac. It's deleted with them.")).toBeTruthy();
  fireEvent.click(within(sheet).getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("macProjects.cancel", { hostedProjectId: "m1" }));
});

it("offers a folder with no remote in the picker and adds it", async () => {
  show();
  expect(await screen.findByRole("option", { name: "drafts · no remote" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("macProjects.add", { localProjectId: "l4" }));
});

function Bring() {
  const bring = useHostedBring("thread-1");
  return (
    <>
      {bring.control}
      {bring.notice}
    </>
  );
}
const showBring = () => render(<QueryClientProvider client={queryClient}>{<Bring />}</QueryClientProvider>);

it("brings a thread's work with no question when nothing would end, and says what came", async () => {
  bringAnswers = [{ brought: { branch: "fix-login", commits: 3, uncommitted: true } }];
  showBring();
  fireEvent.click(await screen.findByRole("button", { name: "Bring to this Mac" }));
  expect(await screen.findByText("Brought 3 commits to this Mac as fix-login. Changes it didn't commit stayed in the cloud.")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(core.call).toHaveBeenCalledWith("macProjects.bring", { threadId: "thread-1", endsOk: false });
});

it("names what would end and goes on only when the person says so", async () => {
  bringAnswers = [{ confirm: ["pnpm dev", "a terminal"] }, { brought: { branch: "fix-login", commits: 1, uncommitted: false } }];
  showBring();
  fireEvent.click(await screen.findByRole("button", { name: "Bring to this Mac" }));
  const sheet = await screen.findByRole("dialog");
  expect(within(sheet).getByText("The thread leaves its cloud machine to save its work, which ends pnpm dev and a terminal.")).toBeTruthy();
  fireEvent.click(within(sheet).getByRole("button", { name: "Bring" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("macProjects.bring", { threadId: "thread-1", endsOk: true }));
  expect(await screen.findByText("Brought 1 commit to this Mac as fix-login.")).toBeTruthy();
});

it("holds Bring with why, and shows nothing for a thread whose project is on GitHub", async () => {
  bringState = { mac: true, can: false, reason: "This project's folder is on another Mac." };
  showBring();
  const held = (await screen.findByRole("button", { name: "Bring to this Mac" })) as HTMLButtonElement;
  expect(held.disabled).toBe(true);
  expect(screen.getByLabelText("Bring to this Mac").getAttribute("aria-disabled")).toBe("true");
  cleanup();
  queryClient.clear();
  bringState = { mac: false };
  showBring();
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("macProjects.bringState", { threadId: "thread-1" }));
  expect(screen.queryByRole("button", { name: "Bring to this Mac" })).toBeNull();
});
