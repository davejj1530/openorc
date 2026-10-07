import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RpcMethod, RpcParams, RpcResults } from "@openorc/protocol";
import { fakeFileDisk } from "../fixtures/file-disk";
import { useLayout } from "../lib/layout";
import { core } from "../lib/rpc";
import { useUi } from "../lib/ui";
import { NewFileDialog } from "./NewFileDialog";

const scope = { kind: "thread", id: "thread" } as const;
let disk: ReturnType<typeof fakeFileDisk>;

beforeEach(() => {
  disk = fakeFileDisk();
  disk.set("src/cart.ts", "export const total = 1;\n");
  vi.spyOn(core, "call").mockImplementation(async <M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> => {
    if (method === "files.write") return disk.write(params as RpcParams<"files.write">) as RpcResults[M];
    throw new Error(`unexpected ${method}`);
  });
  useLayout.setState({ selectedFile: null, panelRequest: null });
  useUi.setState({ newFile: scope });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function create(path: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "Path" }), { target: { value: path } });
  fireEvent.submit(screen.getByRole("textbox", { name: "Path" }).closest("form")!);
}

it("keeps a path outside the folder or inside Git's own files from reaching the disk, and says why", async () => {
  render(<NewFileDialog />);
  create("../x");
  expect((await screen.findByRole("alert")).textContent).toBe("Use a path inside the conversation's folder, such as src/index.ts.");
  create(".git/x");
  expect((await screen.findByRole("alert")).textContent).toBe("Git's own files are read-only here.");
  create("src/.GIT/hooks/pre-commit");
  expect((await screen.findByRole("alert")).textContent).toBe("Git's own files are read-only here.");
  expect(core.call).not.toHaveBeenCalled();
  expect(useUi.getState().newFile).toEqual(scope);
});

it("offers to open a file that already exists, leaving it as it was", async () => {
  render(<NewFileDialog />);
  const before = disk.read("src/cart.ts");
  create("src/cart.ts");
  expect((await screen.findByRole("status")).textContent).toContain("That file already exists.");
  expect(disk.read("src/cart.ts")).toEqual(before);
  expect(disk.writes).toEqual([{ scope, path: "src/cart.ts", text: "", expected: { kind: "absent" } }]);
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(useLayout.getState().selectedFile).toEqual({ path: "src/cart.ts", scope });
  expect(useUi.getState().newFile).toBeNull();
});

it("creates a new file empty and opens it", async () => {
  render(<NewFileDialog />);
  create("  docs/notes.md ");
  await vi.waitFor(() => expect(useUi.getState().newFile).toBeNull());
  expect(disk.read("docs/notes.md")).toMatchObject({ kind: "file", text: "" });
  expect(useLayout.getState().selectedFile).toEqual({ path: "docs/notes.md", scope });
});

it("shows what the core refused, such as a read-only folder", async () => {
  vi.mocked(core.call).mockRejectedValue(new Error("Pull request copies are read-only."));
  render(<NewFileDialog />);
  create("src/new.ts");
  expect((await screen.findByRole("alert")).textContent).toBe("Pull request copies are read-only.");
  expect(useLayout.getState().selectedFile).toBeNull();
});
