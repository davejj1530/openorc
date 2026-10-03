import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { useRouter } from "../lib/router";

vi.mock("../lib/query", () => ({
  useRpc: (method: string) => ({ data: method === "tasks.list" ? [{ status: "review" }, { status: "proposed" }, { status: "backlog" }] : undefined }),
  tagsFor: () => [],
}));
vi.mock("../lib/transcript", () => ({ usePendingApprovals: () => 2 }));
vi.mock("../lib/rpc", () => ({ core: { call: vi.fn() } }));
vi.mock("../lib/window", () => ({ useTrafficLights: () => true, useWindowsControls: () => false }));
vi.mock("./ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ui")>()),
  Tooltip: ({ children }: { children: ReactNode }) => children,
}));

import { WindowNav } from "./Sidebar";

afterEach(cleanup);

it("puts Inbox between the sidebar toggle and search, counting what waits in it", () => {
  const { rerender } = render(<WindowNav open={false} />);
  expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Toggle sidebar", "Inbox, 4", "Search", "Back", "Forward"]);

  const inbox = screen.getByRole("button", { name: "Inbox, 4" });
  expect(inbox.textContent).toBe("4");
  expect(inbox.getAttribute("aria-current")).toBeNull();
  fireEvent.click(inbox);
  expect(useRouter.getState().route).toEqual({ view: "inbox" });
  expect(inbox.getAttribute("aria-current")).toBe("page");
  rerender(<WindowNav open />);
  expect(screen.queryByRole("button", { name: "Search" })).toBeNull();
  expect(screen.getByRole("button", { name: "Inbox, 4" })).toBeTruthy();
});
