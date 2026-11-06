import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { workObjects, type Block, type ReadObject } from "@openorc/client";
import { ReadView } from "./WorkRead";

const media = vi.hoisted(() => ({ basePath: "/repo", fileScope: undefined as { kind: "thread"; id: string } | undefined }));
const listed = vi.hoisted(() => vi.fn());

vi.mock("./ThreadImages", () => ({
  ThreadLink: ({ children, href }: { children: React.ReactNode; href: string }) => <a data-href={href}>{children}</a>,
  useThreadMedia: () => media,
}));
vi.mock("../lib/client", () => ({ useRpc: (method: string, params: { path: string }) => ({ data: method === "files.list" ? listed(params.path) : undefined }) }));
afterEach(() => {
  cleanup();
  media.fileScope = undefined;
  listed.mockReset();
});

const bash = (id: string, command: string): Block => ({ id, kind: "tool", name: "Bash", input: { command }, output: "x", done: true, at: 0 });
const read = (...blocks: Block[]) => workObjects(blocks).find((object): object is ReadObject => object.kind === "read")!;
const show = (object: ReadObject) => render(<ReadView read={object} renderBlocks={(blocks) => <p data-testid="call">{blocks.length} call</p>} />);

it("opens every file it read at the lines it read, whichever way the command read it", () => {
  const { container } = show(read(bash("a", "sed -n 70,100p components/Sidebar.tsx"), bash("b", "cd /repo/harness && cat restart.sh | head -30")));
  expect([...container.querySelectorAll("a[data-href]")].map((link) => link.getAttribute("data-href"))).toEqual(["components/Sidebar.tsx#L70-L100", "/repo/harness/restart.sh#L1-L30"]);
});

it("grows a listed folder into its entries from disk, files opening and folders opening in place", () => {
  media.fileScope = { kind: "thread", id: "t" };
  listed.mockImplementation((path: string) => ({
    root: "/repo",
    entries:
      path === ".tools/build"
        ? [
            { name: "harness", path: ".tools/build/harness", kind: "directory", ignored: false },
            { name: "PLAN.md", path: ".tools/build/PLAN.md", kind: "file", ignored: false },
          ]
        : [{ name: "shoot.sh", path: ".tools/build/harness/shoot.sh", kind: "file", ignored: false }],
  }));
  show(read(bash("l", "cd /repo/.tools && ls build")));
  fireEvent.click(screen.getByRole("button", { name: /build/ }));
  expect(screen.getByText("PLAN.md").closest("a")?.getAttribute("data-href")).toBe(".tools/build/PLAN.md");
  fireEvent.click(screen.getByRole("button", { name: /harness/ }));
  expect(listed).toHaveBeenLastCalledWith(".tools/build/harness");
  expect(screen.getByText("shoot.sh").closest("a")?.getAttribute("data-href")).toBe(".tools/build/harness/shoot.sh");
});

it("grows the call instead for a folder outside the conversation's", () => {
  media.fileScope = { kind: "thread", id: "t" };
  show(read(bash("l", "ls /tmp/elsewhere")));
  fireEvent.click(screen.getByRole("button", { name: /elsewhere/ }));
  expect(listed).not.toHaveBeenCalled();
  expect(screen.getByTestId("call").textContent).toBe("1 call");
});
