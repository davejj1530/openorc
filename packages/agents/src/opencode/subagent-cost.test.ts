import { describe, expect, it } from "vitest";
import { openCodeSubagentCosts } from "./subagent-cost.js";

const session = (id: string, cost: unknown, updated = 1) => ({ id, cost, time: { updated } });

describe("openCodeSubagentCosts", () => {
  it("asks OpenCode for each page of a session's subagents and adds up their cost", async () => {
    const full = Array.from({ length: 200 }, (_, index) => session(`s${index}`, 0.01));
    const asked: string[][] = [];
    const read = openCodeSubagentCosts(async (args) => {
      asked.push(args);
      if (args.includes("parentID=root") && !args.some((arg) => arg.startsWith("cursor="))) return JSON.stringify({ data: full, cursor: { next: "page-2" } });
      if (args.includes("parentID=root")) return JSON.stringify({ data: [session("last", 1)], cursor: { next: "page-3" } });
      return JSON.stringify({ data: [], cursor: { next: null } });
    });
    expect(await read("root")).toBeCloseTo(3, 6);
    expect(asked[0]).toEqual(["api", "--standalone", "session.list", "--param", "parentID=root", "--param", "limit=200"]);
    expect(asked[1]).toEqual(["api", "--standalone", "session.list", "--param", "parentID=root", "--param", "limit=200", "--param", "cursor=page-2"]);
    // One listing per page of the root, then one under each subagent.
    expect(asked).toHaveLength(2 + 201);
  });

  it("counts a missing or malformed cost as nothing and refuses an answer that lists no sessions", async () => {
    expect(await openCodeSubagentCosts(async (args) => JSON.stringify({ data: args.includes("parentID=root") ? [session("a", "1.5"), session("b", 2)] : [] }))("root")).toBe(2);
    await expect(openCodeSubagentCosts(async () => "{}")("root")).rejects.toThrow("OpenCode did not list the sessions.");
  });

  it("lists again under a subagent only once it has changed", async () => {
    let updated = 1;
    const asked: string[] = [];
    const read = openCodeSubagentCosts(async (args) => {
      const parent = args[4]!.slice("parentID=".length);
      asked.push(parent);
      if (parent === "root") return JSON.stringify({ data: [session("a", 1, updated)] });
      if (parent === "a") return JSON.stringify({ data: [session("nested", 0.5)] });
      return JSON.stringify({ data: [] });
    });
    expect(await read("root")).toBe(1.5);
    expect(asked).toEqual(["root", "a", "nested"]);
    asked.length = 0;
    expect(await read("root")).toBe(1.5);
    expect(asked).toEqual(["root"]);
    // Under a subagent that changed, its own unchanged subagents keep what was read under them.
    updated = 2;
    asked.length = 0;
    await read("root");
    expect(asked).toEqual(["root", "a"]);
  });
});
