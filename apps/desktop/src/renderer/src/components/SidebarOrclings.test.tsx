import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { defaultOrclingLook, type ThreadMessage } from "@openorc/protocol";

const { lastMessages } = vi.hoisted(() => ({ lastMessages: new Map<string, ThreadMessage>() }));
vi.mock("../lib/query", () => {
  const rpcData = (method: string, params: { id?: string }) => {
    if (method === "orclings.list") return ["Opi", "Rini", "Nova"].map((name) => ({ id: name, name, threadId: `${name}-thread`, look: defaultOrclingLook }));
    if (method === "threads.get") return { id: params.id, projectId: "workspace", activity: "idle", unread: false, session: { status: "idle", message: null } };
    if (method === "threads.lastMessage") return lastMessages.get(params.id ?? "") ?? null;
    return undefined;
  };
  return { useRpc: (method: string, params: { id?: string }) => ({ data: rpcData(method, params) }) };
});
vi.mock("./ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ui")>()),
  Tooltip: ({ children }: { children: ReactNode }) => children,
}));

import { SidebarOrclings } from "./SidebarOrclings";

afterEach(cleanup);

it("shows each Orcling's last message under its name, marking the person's own", () => {
  lastMessages.set("Opi-thread", { id: "a", role: "assistant", text: "**Done.** Shipped `beta.9` to [releases](https://example.com).", createdAt: 2 });
  lastMessages.set("Rini-thread", { id: "u", role: "user", text: "Can you check the release?", createdAt: 1 });
  render(<SidebarOrclings route={{ view: "thread", threadId: "Opi-thread" }} />);

  const opi = screen.getByRole("button", { name: /Opi/ });
  expect(opi.getAttribute("aria-current")).toBe("page");
  expect(opi.textContent).toBe("OpiDone. Shipped beta.9 to releases.");
  expect(screen.getByRole("button", { name: /Rini/ }).textContent).toBe("RiniYou: Can you check the release?");
  // A new Orcling's conversation has nothing to preview yet.
  expect(screen.getByRole("button", { name: /Nova/ }).textContent).toBe("Nova");
});
