// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentKind, AgentSkill } from "@openorc/protocol";
import { commandWordAt, insertSkill, rankCommands, skillSegments, type SkillCommand, type SkillListOptions } from "./skill-commands.js";
import { testClient } from "./test-fixtures/fake-connection.js";

const names = new Set(["formatting", "code-review", "figma", "figma:figma-use"]);
const marked = (text: string): string[] =>
  skillSegments(text, names)
    .filter((s) => s.skill)
    .map((s) => s.text);
const rebuilt = (text: string): string =>
  skillSegments(text, names)
    .map((s) => s.text)
    .join("");

describe("skill tokens", () => {
  it("marks a name the project has and leaves one it does not", () => {
    expect(marked("/formatting please")).toEqual(["/formatting"]);
    expect(marked("/not-a-skill please")).toEqual([]);
  });

  it("takes the longest name, so a plugin skill is not cut short by its plugin", () => {
    expect(marked("/figma:figma-use")).toEqual(["/figma:figma-use"]);
    expect(marked("/figma on its own")).toEqual(["/figma"]);
  });

  it("only counts a token that starts a word", () => {
    expect(marked("see http://x/formatting for it")).toEqual([]);
    expect(marked("src//formatting")).toEqual([]);
    expect(marked("run /formatting now")).toEqual(["/formatting"]);
    expect(marked("/formatting")).toEqual(["/formatting"]);
  });

  it("does not match a longer word that merely starts with a name", () => {
    expect(marked("/formattings")).toEqual([]);
    expect(marked("/code-review-2")).toEqual([]);
    expect(marked("/code-review.")).toEqual(["/code-review"]);
  });

  it("leaves a path that starts with a name plain", () => {
    expect(marked("see /formatting/output")).toEqual([]);
    expect(marked("/code-review/notes.md")).toEqual([]);
  });

  it("marks every occurrence, across lines", () => {
    expect(marked("/formatting then\n/code-review")).toEqual(["/formatting", "/code-review"]);
  });

  it("marks Codex dollar invocations without marking Claude slash invocations", () => {
    expect(
      skillSegments("$code-review then /code-review", names, "$")
        .filter((segment) => segment.skill)
        .map((segment) => segment.text),
    ).toEqual(["$code-review"]);
  });

  it("never loses or invents a character", () => {
    for (const text of ["", "plain", "/formatting", " /formatting ", "a /figma b /code-review c", "///", "/formatting/formatting"]) {
      expect(rebuilt(text)).toBe(text);
    }
  });

  it("returns the whole message unmarked when the project has no skills", () => {
    expect(skillSegments("/formatting", new Set())).toEqual([{ text: "/formatting", skill: false }]);
    expect(skillSegments("", names)).toEqual([]);
  });
});

describe("the command word at the caret", () => {
  it("is the / or $ word that ends at the caret, at the start or after a space", () => {
    expect(commandWordAt("/co", 3)).toEqual({ start: 0, prefix: "/", query: "co" });
    expect(commandWordAt("please $re", 10)).toEqual({ start: 7, prefix: "$", query: "re" });
    expect(commandWordAt("see /src/a.ts later", 4)).toBeNull();
    expect(commandWordAt("http://x", 8)).toBeNull();
    expect(commandWordAt("costs 5", 7)).toBeNull();
  });
});

describe("ranking what was typed", () => {
  const commands = [{ name: "code-review:code-review" }, { name: "code-review" }, { name: "review", aliases: ["rv"] }, { name: "figma:figma-use" }];
  it("puts a name typed in full first, then names that start with it, then aliases and plugin names", () => {
    expect(rankCommands(commands, "code-review").map((c) => c.name)).toEqual(["code-review", "code-review:code-review"]);
    expect(rankCommands(commands, "rv").map((c) => c.name)).toEqual(["review"]);
    expect(rankCommands(commands, "FIGMA-U").map((c) => c.name)).toEqual(["figma:figma-use"]);
    expect(rankCommands(commands, "").length).toBe(4);
  });
});

describe("inserting a skill", () => {
  it("replaces the word with the skill and one space, keeping one already there, and puts the caret past it", () => {
    expect(insertSkill("please /co", { start: 7 }, 10, { prefix: "/", name: "code-review" })).toEqual({ text: "please /code-review ", caret: 20 });
    expect(insertSkill("/co the diff", { start: 0 }, 3, { prefix: "$", name: "code-review" })).toEqual({ text: "$code-review the diff", caret: 13 });
  });
});

describe("the skills a composer offers each agent", () => {
  const { client, call, wrapper } = testClient();
  const skills: AgentSkill[] = [{ name: "review", description: "Reviews the changes.", source: "project", path: "/repo/.claude/skills/review/SKILL.md" }];
  const scope = { kind: "project", id: "project" } as const;
  const named = (commands: SkillCommand[]) => commands.map((command) => `${command.prefix}${command.name}`);
  const offered = (agent: AgentKind, options?: SkillListOptions) => renderHook(() => named(client.useSkillCommands(scope, agent, undefined, options).commands), { wrapper }).result;
  afterEach(() => {
    cleanup();
    client.queryClient.clear();
    call.mockReset();
  });

  it("names each the way its agent calls it, and offers an agent with no call none", async () => {
    call.mockResolvedValue(skills);
    for (const [agent, name] of [
      ["claude", "/review"],
      ["codex", "$review"],
      ["pi", "/skill:review"],
    ] as const) {
      const result = offered(agent);
      await waitFor(() => expect(result.current).toEqual([name]));
    }
    expect(offered("opencode").current).toEqual([]);
    expect(offered("acp").current).toEqual([]);
    expect(call.mock.calls.map(([, params]) => (params as { agent: string }).agent)).toEqual(["claude", "codex", "pi"]);
  });

  it("names each by its name alone for a prompt that asks by name, for an agent with no call too", async () => {
    call.mockResolvedValue(skills);
    for (const agent of ["pi", "opencode", "acp"] as const) {
      const result = offered(agent, { byName: true });
      await waitFor(() => expect(result.current).toEqual(["/review"]));
    }
    expect(call.mock.calls.map(([, params]) => (params as { agent: string }).agent)).toEqual(["pi", "opencode"]);
  });
});
