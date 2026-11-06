import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { CloudSkills } from "@openorc/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { CloudSkillsSection } from "./settings-cloud-skills";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: vi.fn(), onPush: () => () => {} } }));
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.resetAllMocks();
});

function show(skills: CloudSkills) {
  vi.mocked(core.call).mockImplementation(async (method: string, params: unknown) => {
    if (method === "cloud.skills") return skills as never;
    if (method === "cloud.skills.choose") {
      const { agent, name, on } = params as { agent: string; name: string; on: boolean };
      return {
        agents: skills.agents.map((each) => (each.agent === agent ? { ...each, skills: each.skills.map((skill) => (skill.name === name ? { ...skill, chosen: on } : skill)) } : each)),
      } as never;
    }
    throw new Error(`unexpected ${method}`);
  });
  render(
    <QueryClientProvider client={queryClient}>
      <CloudSkillsSection active />
    </QueryClientProvider>,
  );
}

const skill = (name: string, chosen = false) => ({ name, description: `${name} things`, chosen });
const row = (label: string) => screen.getByText(label).closest(".settings-field") as HTMLElement;
const toggle = (name: string) => screen.getByRole("switch", { name: `${name} in cloud threads` }) as HTMLInputElement;

it("sums up each agent's chosen skills in a row, leaving out an agent with none, and chooses them in a sheet", async () => {
  show({
    agents: [
      { agent: "codex", skills: [], error: null },
      { agent: "claude", skills: [skill("review", true), skill("draft")], error: null },
      { agent: "opencode", skills: [skill("a", true), skill("b", true), skill("c", true), skill("d")], error: null },
    ],
  });
  expect(await screen.findByText("Claude Code")).toBeTruthy();
  expect(screen.queryByText("Codex")).toBeNull();
  expect(within(row("Claude Code")).getByText("review")).toBeTruthy();
  expect(within(row("OpenCode")).getByText("3 of 4 chosen")).toBeTruthy();
  fireEvent.click(within(row("Claude Code")).getByRole("button", { name: "Choose" }));
  expect([toggle("review").checked, toggle("draft").checked]).toEqual([true, false]);
  fireEvent.click(toggle("draft"));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.skills.choose", { agent: "claude", name: "draft", on: true }));
  await waitFor(() => expect(toggle("draft").checked).toBe(true));
});

it("filters a long list by name or description", async () => {
  show({ agents: [{ agent: "codex", skills: Array.from({ length: 12 }, (_, index) => skill(`skill-${index}`)), error: null }] });
  fireEvent.click(within(await screen.findByText("Codex").then(() => row("Codex"))).getByRole("button", { name: "Choose" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Filter skills" }), { target: { value: "skill-1" } });
  expect(screen.getAllByRole("switch").map((input) => input.getAttribute("aria-label"))).toEqual(["skill-1 in cloud threads", "skill-10 in cloud threads", "skill-11 in cloud threads"]);
  fireEvent.change(screen.getByRole("textbox", { name: "Filter skills" }), { target: { value: "nothing" } });
  expect(screen.getByText("No skill matches.")).toBeTruthy();
});

it("says why an agent's skills could not be listed", async () => {
  show({ agents: [{ agent: "codex", skills: [], error: "Codex could not list skills for this project." }] });
  expect(await screen.findByText("Codex could not list skills for this project.")).toBeTruthy();
});

it("shows nothing while no agent has skills of its own", async () => {
  show({
    agents: [
      { agent: "codex", skills: [], error: null },
      { agent: "claude", skills: [], error: null },
    ],
  });
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("cloud.skills", {}));
  expect(screen.queryByRole("heading")).toBeNull();
});
