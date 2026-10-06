import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Orchestration } from "./Orchestration";
import { core } from "../lib/rpc";
import { queryClient } from "../lib/query";
import { useRouter } from "../lib/router";
import { DEFAULT_TEAM_LIMITS, defaultOrclingLook, TeamDetail, type Orcling } from "@openorc/protocol";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onInvalidate: vi.fn(), onReady: vi.fn() } }));
vi.mock("../components/TopBar", () => ({ TopBar: () => null }));

let enabled = false;
let availabilityError = false;
let detail: TeamDetail | null = null;
let saveFailure = false;
let avatarIndex = 0;
let orclingList: Orcling[] = [];

function savedTeam() {
  return TeamDetail.parse({
    team: { id: "team", projectId: "project", currentRevisionId: "revision-1", archivedAt: null, createdAt: 1, updatedAt: 1 },
    revision: {
      id: "revision-1",
      teamId: "team",
      projectId: "project",
      number: 1,
      createdAt: 1,
      name: "Review team",
      limits: DEFAULT_TEAM_LIMITS,
      members: [{ key: "lead", name: "Lead", responsibility: "Coordinate", managerKey: null, settings: { agent: "codex", model: "model", effort: null, fastMode: false } }],
    },
  });
}

beforeEach(() => {
  enabled = false;
  availabilityError = false;
  detail = null;
  saveFailure = false;
  avatarIndex = 0;
  orclingList = [];
  localStorage.clear();
  useRouter.setState({ route: { view: "orchestration", projectId: "project" }, threadIds: [], history: [], future: [] });
  vi.mocked(core.call).mockImplementation(async (method, input) => {
    if (method === "projects.list") return [{ id: "project", name: "Example" }] as never;
    if (method === "orchestration.list") return (detail ? [detail] : []) as never;
    if (method === "orchestration.get") return detail as never;
    if (method === "orchestration.avatars.list") return [{ teamId: "team", memberKey: "lead", avatar: { kind: "default", index: avatarIndex }, updatedAt: 1 }] as never;
    if (method === "orchestration.avatars.set") {
      avatarIndex = (input as { avatar: { index: number } }).avatar.index;
      return { teamId: "team", memberKey: "lead", avatar: { kind: "default", index: avatarIndex }, updatedAt: 2 } as never;
    }
    if (method === "orchestration.save") {
      if (saveFailure) throw new Error("Save unavailable");
      const request = input as { draft: TeamDetail["revision"]; expectedRevisionId: string | null };
      const current = detail ?? savedTeam();
      detail = { team: { ...current.team, currentRevisionId: "revision-2" }, revision: { ...current.revision, ...request.draft, id: "revision-2", number: 2 } };
      return detail as never;
    }
    if (method === "orchestration.archive") {
      detail = { ...detail!, team: { ...detail!.team, archivedAt: (input as { archived: boolean }).archived ? 2 : null } };
      return detail as never;
    }
    if (method === "orchestration.availability") {
      if (availabilityError) throw new Error("Connection lost");
      return { enabled, reason: enabled ? null : "Team execution is disabled.", maxHierarchyDepth: 3 };
    }
    if (method === "agents.models") return [];
    if (method === "orclings.list") return orclingList as never;
    if (method === "system.info") return { harnesses: [{ id: "codex", state: "ready", path: "/bin/codex", version: "1", revision: 1 }] } as never;
    throw new Error(`Unexpected RPC: ${method}`);
  });
});

it("seats an Orcling under its own name and face, which only the Orcling's own settings change", async () => {
  const saved = savedTeam();
  saved.revision.members[0] = { ...saved.revision.members[0]!, name: "Gloop", orclingId: "gloop" };
  detail = saved;
  orclingList = [
    {
      id: "gloop",
      name: "Gloop",
      look: defaultOrclingLook,
      settings: { agent: "codex", model: "model", effort: null, fastMode: false },
      permission: "allow",
      threadId: "home",
      createdAt: 1,
      updatedAt: 1,
    },
  ];
  render(
    <QueryClientProvider client={queryClient}>
      <Orchestration projectId="project" teamId="team" />
    </QueryClientProvider>,
  );
  const memberName = (await screen.findByRole("textbox", { name: "Member name" })) as HTMLInputElement;
  await waitFor(() => expect(memberName.disabled).toBe(true));
  expect(memberName.value).toBe("Gloop");
  expect(screen.queryByRole("button", { name: "Choose default" })).toBeNull();
});

it("keeps edits after a failed save and blocks archiving until the draft is discarded", async () => {
  detail = savedTeam();
  saveFailure = true;
  render(
    <QueryClientProvider client={queryClient}>
      <Orchestration projectId="project" teamId="team" />
    </QueryClientProvider>,
  );
  const name = await screen.findByRole("textbox", { name: "Team name" });
  fireEvent.change(name, { target: { value: "Changed team" } });
  expect((screen.getByRole("button", { name: "Archive" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Save team" }));
  await screen.findByText("Save unavailable");
  expect((name as HTMLInputElement).value).toBe("Changed team");
  expect(localStorage.getItem("openorc.draft.orchestration.project.team")).toContain("Changed team");
  fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
  fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
  await waitFor(() => expect((screen.getByRole("textbox", { name: "Team name" }) as HTMLInputElement).value).toBe("Review team"));
  fireEvent.click(screen.getByRole("button", { name: "Archive" }));
  await waitFor(() => expect(detail?.team.archivedAt).toBe(2));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Team name" }).matches(":disabled")).toBe(true));
});

it("keeps a dirty draft on a remote revision and retains the avatar choice after mutation", async () => {
  detail = savedTeam();
  render(
    <QueryClientProvider client={queryClient}>
      <Orchestration projectId="project" teamId="team" />
    </QueryClientProvider>,
  );
  const name = await screen.findByRole("textbox", { name: "Team name" });
  fireEvent.click(await screen.findByRole("button", { name: "Choose default" }));
  const choices = screen.getAllByRole("radio");
  fireEvent.click(choices[1]!);
  await waitFor(() => expect(vi.mocked(core.call)).toHaveBeenCalledWith("orchestration.avatars.set", { teamId: "team", memberKey: "lead", avatar: { kind: "default", index: 1 } }));
  fireEvent.click(await screen.findByRole("button", { name: "Choose default" }));
  await waitFor(() => expect(screen.getAllByRole("radio")[1]?.getAttribute("aria-checked")).toBe("true"));
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  fireEvent.change(name, { target: { value: "My unfinished team" } });
  detail = { ...detail!, team: { ...detail!.team, currentRevisionId: "revision-2" }, revision: { ...detail!.revision, id: "revision-2", number: 2, name: "Remote edit" } };
  await queryClient.invalidateQueries({ queryKey: ["orchestration.get", { id: "team" }] });
  await screen.findByText(/A newer version was saved in another window/);
  expect((name as HTMLInputElement).value).toBe("My unfinished team");
  expect((screen.getByRole("button", { name: "Save team" }) as HTMLButtonElement).disabled).toBe(true);
});

it("reports a hierarchy cycle before any save request", async () => {
  const saved = savedTeam();
  detail = {
    ...saved,
    revision: {
      ...saved.revision,
      members: [
        ...saved.revision.members,
        { key: "manager", name: "Manager", responsibility: "Assign", managerKey: "lead", settings: saved.revision.members[0]!.settings },
        { key: "worker", name: "Worker", responsibility: "Build", managerKey: "manager", settings: saved.revision.members[0]!.settings },
      ],
    },
  };
  render(
    <QueryClientProvider client={queryClient}>
      <Orchestration projectId="project" teamId="team" />
    </QueryClientProvider>,
  );
  await screen.findByRole("textbox", { name: "Team name" });
  fireEvent.change(screen.getAllByRole("combobox", { name: "Reports to" })[1]!, { target: { value: "worker" } });
  fireEvent.click(screen.getByRole("button", { name: "Save team" }));
  await screen.findByText("An agent cannot manage itself or form a management cycle.");
  expect(vi.mocked(core.call).mock.calls.filter(([method]) => method === "orchestration.save")).toHaveLength(0);
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});

it("shows when team execution is off, links to its setting, and updates when enabled", async () => {
  render(
    <QueryClientProvider client={queryClient}>
      <Orchestration projectId="project" />
    </QueryClientProvider>,
  );

  expect((await screen.findByText("Team execution off")).closest('[role="status"]')?.textContent).toContain("You can design and save teams");
  enabled = true;
  await queryClient.invalidateQueries({ queryKey: ["orchestration.availability", {}] });
  await waitFor(() => expect(screen.getByText("Team execution on · Beta")).toBeTruthy());
  availabilityError = true;
  await queryClient.invalidateQueries({ queryKey: ["orchestration.availability", {}] });
  await screen.findByText("Status unavailable");
  expect(screen.queryByText("Team execution on · Beta")).toBeNull();
  availabilityError = false;
  enabled = false;
  await queryClient.invalidateQueries({ queryKey: ["orchestration.availability", {}] });
  await screen.findByText("Team execution off");
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(useRouter.getState().route).toEqual({ view: "settings", section: "general", setting: "team-execution" });
});
