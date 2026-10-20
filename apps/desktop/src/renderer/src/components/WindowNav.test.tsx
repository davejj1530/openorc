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

it("reads Inbox, Search, then the sidebar toggle, counting what waits in the inbox, with no window history buttons", () => {
  const { rerender } = render(<WindowNav open={false} />);
  expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Inbox, 4", "Search", "Toggle sidebar"]);
  expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Forward" })).toBeNull();

  const inbox = screen.getByRole("button", { name: "Inbox, 4" });
  expect(inbox.textContent).toBe("4");
  expect(inbox.getAttribute("aria-current")).toBeNull();
  fireEvent.click(inbox);
  expect(useRouter.getState().route).toEqual({ view: "inbox" });
  expect(inbox.getAttribute("aria-current")).toBe("page");
  rerender(<WindowNav open />);
  expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Inbox, 4", "Search", "Toggle sidebar"]);
});

it("caps the inbox count at 99+", async () => {
  const query = await import("../lib/query");
  vi.spyOn(query, "useRpc").mockReturnValue({ data: Array.from({ length: 120 }, () => ({ status: "review" })) } as never);
  render(<WindowNav open={false} />);
  expect(screen.getByRole("button", { name: "Inbox, 122" }).textContent).toBe("99+");
});
