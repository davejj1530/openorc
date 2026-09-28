import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FilePanel } from "./FilePanel";
import { type FileSelection } from "../lib/layout";

const document = "# Investigation\n\nPrompt construction: [runs.ts](../packages/core/src/services/runs.ts)\n";
vi.mock("../lib/query", () => ({
  useRpc: () => ({ data: { path: "/repo/.local-development/notes.md", content: document }, isLoading: false, isFetching: false, error: null }),
}));
vi.mock("@pierre/diffs/worker/worker.js?worker", () => ({ default: class {} }));
vi.mock("@pierre/diffs/react", () => ({
  WorkerPoolContextProvider: ({ children }: { children: unknown }) => children,
  CodeView: () => <pre>source view</pre>,
}));

afterEach(cleanup);

const scope = { kind: "thread", id: "a" } as const;
const selection = (extra: Partial<FileSelection> = {}): FileSelection => ({ path: ".local-development/notes.md", scope, ...extra });

it("opens a cited line in the source and switches to the rendered view on request", async () => {
  render(<FilePanel selection={selection({ line: 3 })} />);
  expect(screen.getByText("source view")).toBeTruthy();

  fireEvent.click(screen.getByRole("radio", { name: "Preview" }));
  expect(await screen.findByRole("heading", { name: "Investigation" })).toBeTruthy();
  expect(screen.queryByText("source view")).toBeNull();
});

it("keeps other files in the source view without a switch", () => {
  render(<FilePanel selection={selection({ path: "src/index.ts" })} />);
  expect(screen.getByText("source view")).toBeTruthy();
  expect(screen.queryByRole("radiogroup", { name: "File view" })).toBeNull();
});
