// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { claimTerminal, terminalNames } from "./cloud-terminal-claims";

afterEach(() => localStorage.clear());

it("names each terminal as the tab that shows it, and the others by names no tab has", () => {
  claimTerminal("t1", "main", "terminal-a");
  claimTerminal("t1", "shell-3", "terminal-c");
  const shells = [null, { id: "shell-3", number: 3 }];
  const names = terminalNames("t1", shells, ["terminal-a", "terminal-b", "terminal-c", "terminal-d"]);
  expect(Object.fromEntries(names)).toEqual({ "terminal-a": "Terminal", "terminal-c": "Terminal 3", "terminal-b": "Terminal 2", "terminal-d": "Terminal 4" });
  // With no tab here, they read as tabs would.
  expect([...terminalNames("t2", [], ["terminal-x", "terminal-y"]).values()]).toEqual(["Terminal", "Terminal 2"]);
});
