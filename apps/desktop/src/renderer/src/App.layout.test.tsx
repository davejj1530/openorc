import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.hoisted(() => Object.assign(window, { openorc: { platform: "darwin", onTheme: () => () => {}, setTheme: () => {}, openExternal: () => {} } }));
vi.mock("./lib/rpc", () => ({ core: { call: vi.fn(async () => []), onFrame: () => () => {}, onInvalidate: () => () => {}, onReady: () => () => {} } }));
vi.mock("./components/Sidebar", () => ({ Sidebar: () => null, WindowNav: () => null }));
vi.mock("./components/NewThreadMascot", () => ({ NewThreadMascot: () => null }));
vi.mock("./components/Composer", () => ({ Composer: () => <textarea aria-label="Message" />, ComposerChoice: () => null }));
// Keep App and NewThread's real column structure. Panel content cannot own the
// rounded conversation frame; its opaque background would cover the seam.
vi.mock("./components/Panel", () => ({
  Panel: () => <aside className="panel-shell" data-open="true" aria-label="Changes panel" />,
  PanelToggle: () => null,
}));
vi.mock("./lib/query", () => {
  const project = { id: "project", name: "Project", rootPath: "/fixture", settings: {} };
  const data: Record<string, unknown> = {
    "projects.list": [project],
    "workspace.get": null,
    "system.info": { harnesses: [{ id: "codex", state: "ready" }], gh: { installed: false } },
    "app.settings.get": { defaultPermissionMode: "review", defaultWorkspaceMode: "current" },
    "orchestration.availability": { enabled: false },
    "review.projectDiff": { files: [], patch: "" },
  };
  const empty: unknown[] = [];
  return {
    useRpc: (method: string) => ({ data: method in data ? data[method] : empty, isSuccess: true, refetch: vi.fn() }),
    useRpcMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
    invalidateTags: vi.fn(),
  };
});

import { App } from "./App";
import { useRouter } from "./lib/router";
import { useLayout } from "./lib/layout";

afterEach(cleanup);

it("keeps the new-thread panel outside the conversation's rounded frame", () => {
  useRouter.setState({ route: { view: "newthread", projectId: "project" }, history: [], future: [] });
  useLayout.setState({ projectId: "project", panelOpen: true, panelTab: "changes" });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <App />
    </QueryClientProvider>,
  );
  const middle = screen.getByRole("textbox", { name: "Message" }).closest(".well");
  const panel = screen.getByRole("complementary", { name: "Changes panel" });
  expect(middle).not.toBeNull();
  expect(middle!.contains(panel)).toBe(false);
  expect(middle!.parentElement).toBe(panel.parentElement);
  expect(panel.parentElement?.classList.contains("work-row")).toBe(true);
});
