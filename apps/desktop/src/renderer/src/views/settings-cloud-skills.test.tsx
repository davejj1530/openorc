import type { CloudSkill, HarnessId } from "@openorc/protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { CloudSkillsSection } from "./settings-cloud-skills";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
vi.mock("../lib/browser-preview", () => ({ CoversPreview: () => null }));

const skill = (name: string, more: Partial<CloudSkill> = {}): CloudSkill => ({ name, description: `What ${name} does.`, bytes: 2048, on: true, cause: null, ...more });
let skills: Record<string, CloudSkill[]>;

beforeEach(() => {
  skills = {
    claude: [
      skill("review"),
      skill("notes", { on: false }),
      skill("video-cuts", { bytes: 18 * 1024 * 1024 }),
      skill("ui-ux", { bytes: null, cause: "its link data points to something that is no longer there." }),
    ],
    codex: [skill("plan")],
    opencode: [],
  };
  vi.mocked(core.call).mockImplementation((async (method: string, params: { agent: HarnessId; names: string[]; on: boolean }) => {
    if (method === "app.settings.get") return { enabledHarnesses: ["claude", "codex", "opencode"] };
    if (method === "hostedSkills.list") return skills[params.agent];
    if (method === "hostedSkills.choose") {
      skills[params.agent] = skills[params.agent]!.map((one) => (params.names.includes(one.name) ? { ...one, on: params.on } : one));
      return skills[params.agent];
    }
    return null;
  }) as never);
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});

const show = () => render(<QueryClientProvider client={queryClient}>{<CloudSkillsSection active />}</QueryClientProvider>);

it("names how many of each agent's skills go, OpenCode's too, and opens one agent's switches", async () => {
  show();
  expect(await screen.findByText("2 of 4 go to the cloud")).toBeTruthy();
  expect(await screen.findByText("It goes to the cloud")).toBeTruthy();
  expect(await screen.findByText("No skills")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Choose" })).toHaveLength(2);
  fireEvent.click(screen.getAllByRole("button", { name: "Choose" })[0]!);
  const sheet = await screen.findByRole("dialog");
  expect(within(sheet).getByText("Claude Code skills in the cloud")).toBeTruthy();
  expect(within(sheet).getByText("18 MB")).toBeTruthy();
  expect(within(sheet).getAllByText("2.0 KB")).toHaveLength(2);
});

it("holds a skill this Mac can't read, with why on hover, and leaves it out of all on and all off", async () => {
  show();
  fireEvent.click((await screen.findAllByRole("button", { name: "Choose" }))[0]!);
  const sheet = await screen.findByRole("dialog");
  const held = within(sheet).getByRole("switch", { name: "ui-ux in cloud threads" }) as HTMLInputElement;
  expect(held.disabled).toBe(true);
  expect(held.checked).toBe(false);
  expect(held.closest("[data-tip]")?.getAttribute("data-tip")).toBe("Its link data points to something that is no longer there.");
  expect(within(sheet).getByText("Can't be read")).toBeTruthy();
  fireEvent.click(within(sheet).getByRole("button", { name: "All on" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("hostedSkills.choose", { agent: "claude", names: ["notes", "review", "video-cuts"], on: true }));
  expect(await screen.findByText("3 of 4 go to the cloud")).toBeTruthy();
});

it("searches names and words, and turns off only what the search shows", async () => {
  show();
  fireEvent.click((await screen.findAllByRole("button", { name: "Choose" }))[0]!);
  const sheet = await screen.findByRole("dialog");
  fireEvent.change(within(sheet).getByRole("textbox", { name: "Search skills" }), { target: { value: "VIDEO" } });
  expect(within(sheet).queryByRole("switch", { name: "review in cloud threads" })).toBeNull();
  fireEvent.click(within(sheet).getByRole("button", { name: "All off" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("hostedSkills.choose", { agent: "claude", names: ["video-cuts"], on: false }));
  fireEvent.change(within(sheet).getByRole("textbox", { name: "Search skills" }), { target: { value: "nothing like it" } });
  expect(within(sheet).getByText("No skill matches.")).toBeTruthy();
  expect((within(sheet).getByRole("button", { name: "All on" }) as HTMLButtonElement).disabled).toBe(true);
});

it("turns one skill off from its switch", async () => {
  show();
  fireEvent.click((await screen.findAllByRole("button", { name: "Choose" }))[0]!);
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("switch", { name: "review in cloud threads" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("hostedSkills.choose", { agent: "claude", names: ["review"], on: false }));
});

it("holds only the switch being changed while its choice is on its way", async () => {
  let answer: () => void = () => {};
  const call = vi.mocked(core.call).getMockImplementation()!;
  vi.mocked(core.call).mockImplementation(((method: string, params: never) =>
    method === "hostedSkills.choose" ? new Promise((resolve) => (answer = () => resolve(call(method as never, params)))) : call(method as never, params)) as never);
  show();
  fireEvent.click((await screen.findAllByRole("button", { name: "Choose" }))[0]!);
  const sheet = await screen.findByRole("dialog");
  fireEvent.click(within(sheet).getByRole("switch", { name: "review in cloud threads" }));
  await waitFor(() => expect((within(sheet).getByRole("switch", { name: "review in cloud threads" }) as HTMLInputElement).disabled).toBe(true));
  expect((within(sheet).getByRole("switch", { name: "notes in cloud threads" }) as HTMLInputElement).disabled).toBe(false);
  answer();
  await waitFor(() => expect((within(sheet).getByRole("switch", { name: "review in cloud threads" }) as HTMLInputElement).disabled).toBe(false));
});
