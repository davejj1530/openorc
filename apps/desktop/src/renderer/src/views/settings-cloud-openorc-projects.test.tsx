import type { AccountStatus } from "@openorc/protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { CloudProjects, GithubRow } from "./settings-cloud-openorc-projects";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
type SignedIn = Extract<AccountStatus, { state: "signed-in" }>;
const account: SignedIn = {
  state: "signed-in",
  email: "ada@example.com",
  name: "Ada",
  image: null,
  reach: "live",
  plan: { pro: true, standing: "live", at: 0 },
  hours: null,
  sandbox: null,
  signIns: [],
  signingIn: {},
  github: { configured: true, login: null, installedOn: [], repositories: [] },
  connectingGithub: null,
  paying: null,
  projects: [],
  error: null,
};
beforeEach(() => {
  vi.mocked(core.call).mockImplementation((async (method: string) => {
    if (method === "projects.list")
      return [
        { id: "mac-api", name: "api" },
        { id: "mac-site", name: "site" },
        { id: "mac-docs", name: "docs" },
      ];
    return account;
  }) as never);
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});

const show = (node: React.ReactNode) => render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);

it("connects GitHub, waits on the browser with Cancel, and says a failed trip in its words", async () => {
  show(<GithubRow account={account} />);
  fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("account.github.connect", {}));
  cleanup();
  show(<GithubRow account={{ ...account, connectingGithub: { state: "waiting" } }} />);
  expect(screen.getByText("Waiting for GitHub")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("account.github.cancel", {}));
  cleanup();
  show(<GithubRow account={{ ...account, connectingGithub: { state: "failed", error: "GitHub sign-in was cancelled." } }} />);
  expect(screen.getByText("GitHub sign-in was cancelled.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Connect GitHub" })).toBeTruthy();
});

it("shows who GitHub is connected as and what it reaches, with Disconnect, and nothing when the server has no GitHub app", async () => {
  show(<GithubRow account={{ ...account, github: { configured: true, login: "ada", installedOn: ["acme"], repositories: ["acme/api", "acme/site"] } }} />);
  expect(screen.getByText("ada · 2 repositories")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("account.github.disconnect", {}));
  cleanup();
  const { container } = show(<GithubRow account={{ ...account, github: { configured: false, login: null, installedOn: [], repositories: [] } }} />);
  expect(container.textContent).toBe("");
});

it("lists the projects on OpenOrc Cloud and adds another, naming why GitHub keeps one out", async () => {
  const projects: SignedIn["projects"] = [
    { projectId: "mac-api", repo: "acme/api", cloud: "added" },
    { projectId: "mac-docs", repo: "acme/docs", cloud: "unreadable" },
    { projectId: "mac-site", repo: "acme/site", cloud: "addable" },
  ];
  show(<CloudProjects account={{ ...account, projects }} active />);
  await waitFor(() => expect(screen.getByText("api")).toBeTruthy());
  expect(screen.getByText("Added")).toBeTruthy();
  const keptOut = screen.getByRole("option", { name: "docs · GitHub doesn't let OpenOrc read it yet" }) as HTMLOptionElement;
  expect(keptOut.disabled).toBe(true);
  expect((screen.getByRole("combobox", { name: "Project" }) as HTMLSelectElement).value).toBe("mac-site");
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("account.projects.add", { projectId: "mac-site" }));
});
