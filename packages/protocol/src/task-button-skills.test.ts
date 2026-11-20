import { expect, it } from "vitest";
import { TaskButton } from "./domain.js";
import { savedSkillPrompt, skillCall, skillPrompt } from "./task-button-skills.js";

const skills = ["review-mine"];

it("writes a button's skill calls the way the agent running it calls skills", () => {
  expect(skillPrompt("/review-mine the changes", skills, "claude")).toBe("/review-mine the changes");
  expect(skillPrompt("/review-mine the changes", skills, "cursor")).toBe("/review-mine the changes");
  expect(skillPrompt("/review-mine the changes", skills, "codex")).toBe("$review-mine the changes");
  expect(skillPrompt("/review-mine the changes", skills, "fx")).toBe("$review-mine the changes");
  expect(skillPrompt("/review-mine the changes", skills, "pi")).toBe("/skill:review-mine the changes");
  expect(skillPrompt("/review-mine the changes", skills, "omp")).toBe("/skill:review-mine the changes");
  expect(skillPrompt("$review-mine", skills, "claude")).toBe("/review-mine");
  expect(skillPrompt("/skill:review-mine", skills, "codex")).toBe("$review-mine");
});

it("asks an agent with no call for skills, OpenCode or one reached through ACP, for the skill by name", () => {
  for (const agent of ["opencode", "acp"] as const) {
    expect(skillPrompt("/review-mine the changes", skills, agent)).toBe("Use the review-mine skill: the changes");
    expect(skillPrompt("/review-mine", skills, agent)).toBe("Use the review-mine skill.");
    expect(skillPrompt("/review-mine, then list the risks", skills, agent)).toBe("Use the review-mine skill, then list the risks");
    expect(skillPrompt("Then run /review-mine on /src/app.", skills, agent)).toBe("Then run the review-mine skill on /src/app.");
    expect(skillPrompt("Run $review-mine.", skills, agent)).toBe("Run the review-mine skill.");
  }
  expect(skillCall("review-mine", "opencode")).toBeNull();
  expect(skillCall("review-mine", "omp")).toBe("/skill:review-mine");
});

it("leaves every other word as written", () => {
  expect(skillPrompt("Run /review-mine.", skills, "codex")).toBe("Run $review-mine.");
  expect(skillPrompt("Then run /review-mine\nand /lint-all on /src/app", skills, "codex")).toBe("Then run $review-mine\nand /lint-all on /src/app");
  expect(skillPrompt("/src/app and a/review-mine and /review-mine-twice", skills, "codex")).toBe("/src/app and a/review-mine and /review-mine-twice");
  expect(skillPrompt("/review-mine", undefined, "codex")).toBe("/review-mine");
  expect(skillPrompt("/review-mine", [], "codex")).toBe("/review-mine");
});

it("saves a prompt's calls of known skills as /name, with the skills it calls", () => {
  expect(savedSkillPrompt("$say-hello, then /skill:review-mine and /src/app", ["review-mine", "say-hello", "unused"])).toEqual({
    prompt: "/say-hello, then /review-mine and /src/app",
    skills: ["say-hello", "review-mine"],
  });
  expect(savedSkillPrompt("/say-hello", [])).toEqual({ prompt: "/say-hello", skills: [] });
});

it("takes a task button with the skills it calls, or without any as saved before", () => {
  const review = { id: "review", label: "Review", prompt: "/review-mine the task's changes.", runsIn: "new", mode: "plan" };
  expect(TaskButton.parse(review)).toEqual(review);
  expect(TaskButton.parse({ ...review, skills })).toEqual({ ...review, skills });
  expect(() => TaskButton.parse({ ...review, skills: [""] })).toThrow();
  expect(() => TaskButton.parse({ ...review, skills: Array.from({ length: 21 }, (_, i) => `s${i}`) })).toThrow();
});
