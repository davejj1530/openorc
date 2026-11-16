// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { claimTerminal, terminalName, terminalNumbers } from "./cloud-terminal-claims";

const names = (numbers: Map<string, number>) => Object.fromEntries([...numbers].map(([id, number]) => [id, terminalName(number)]));

afterEach(() => localStorage.clear());

it("names each terminal as the tab that shows it, and the others by names no tab has", () => {
  claimTerminal("t1", "main", "terminal-a");
  claimTerminal("t1", "shell-3", "terminal-c");
  const shells = [null, { id: "shell-3", number: 3 }];
  expect(names(terminalNumbers("t1", shells, ["terminal-a", "terminal-b", "terminal-c", "terminal-d"]))).toEqual({
    "terminal-a": "Terminal",
    "terminal-c": "Terminal 3",
    "terminal-b": "Terminal 2",
    "terminal-d": "Terminal 4",
  });
  // With no tab here, they read as tabs would.
  expect(Object.values(names(terminalNumbers("t2", [], ["terminal-x", "terminal-y"])))).toEqual(["Terminal", "Terminal 2"]);
});

it("keeps a terminal's name while it runs, as others end around it", () => {
  const first = terminalNumbers("t3", [], ["terminal-a", "terminal-b", "terminal-c"]);
  const after = terminalNumbers("t3", [], ["terminal-a", "terminal-c"], first);
  expect(names(after)).toEqual({ "terminal-a": "Terminal", "terminal-c": "Terminal 3" });
  // A new one takes the name that came free.
  expect(names(terminalNumbers("t3", [], ["terminal-a", "terminal-c", "terminal-d"], after))).toEqual({ "terminal-a": "Terminal", "terminal-c": "Terminal 3", "terminal-d": "Terminal 2" });
});
