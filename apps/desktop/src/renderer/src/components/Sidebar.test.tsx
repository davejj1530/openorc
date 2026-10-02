import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { defaultOrclingLook, WORKSPACE_ID } from "@openorc/protocol";

vi.mock("../lib/query", () => {
  const rpcData = (method: string, params: { id?: string }) => {
    if (method === "orclings.list") return [{ id: "rini", name: "Rini", threadId: "rini-home", look: defaultOrclingLook }];
    if (method === "threads.get") return { id: params.id, title: "Notes", projectId: WORKSPACE_ID, agent: "codex", activity: "idle", unread: false, session: { status: "idle", message: null } };
    return undefined;
  };
  return { useRpc: (method: string, params: { id?: string }) => ({ data: rpcData(method, params) }), tagsFor: () => [] };
});
vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(async () => []) } }));
vi.mock("../lib/transcript", () => ({ usePendingApprovals: () => 0 }));
vi.mock("../lib/window", () => ({ useTrafficLights: () => false, useWindowsControls: () => false }));
vi.mock("../lib/browser-preview", () => ({ CoversPreview: () => null }));
vi.mock("./ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ui")>()),
  Tooltip: ({ children }: { children: ReactNode }) => children,
}));

import { useLayout } from "../lib/layout";
import { useRouter } from "../lib/router";
import { Sidebar } from "./Sidebar";

afterEach(cleanup);

const folded = `project:${WORKSPACE_ID}`;
const open = (threadId: string) => {
  useLayout.setState({ collapsed: [folded] });
  useRouter.setState({ route: { view: "thread", threadId } });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Sidebar />
    </QueryClientProvider>,
  );
};

it("unfolds the project that lists the opened thread", () => {
  open("notes");
  expect(useLayout.getState().collapsed).not.toContain(folded);
});

it("leaves Workspace folded when an Orcling's own conversation opens, since Orclings list it", () => {
  open("rini-home");
  expect(useLayout.getState().collapsed).toContain(folded);
});
