import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TaskCard } from "../components/TaskCard";
import { useRouter } from "../lib/router";
import { Inbox } from "./Inbox";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onReady: () => {}, onPush: () => () => {} } }));
vi.mock("../components/TopBar", () => ({ TopBar: () => null }));
afterEach(cleanup);

const task = { id: "task", title: "Review keyboard navigation", status: "review", updatedAt: 0, baseSha: null };

function client() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["tasks.get", { id: task.id }], task);
  client.setQueryData(["runs.listForTask", { taskId: task.id }], []);
  useRouter.setState({ route: { view: "tasks" } });
  return client;
}

it.each([task.title, `Open ${task.title}`])("opens Overview from the review task card's %s button", (name) => {
  render(
    <QueryClientProvider client={client()}>
      <TaskCard taskId={task.id} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name }));
  expect(useRouter.getState().route).toEqual({ view: "task", taskId: task.id, tab: "spec" });
});

it.each(["review", "proposed", "approval"])("opens the relevant page for an inbox task needing %s", (reason) => {
  const cache = client();
  cache.setQueryData(["inbox.list", {}], { items: [{ kind: "task", reason, task, detail: "Ready for review", runId: null }] });
  render(
    <QueryClientProvider client={cache}>
      <Inbox />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /Review keyboard navigation/ }));
  expect(useRouter.getState().route).toEqual({ view: "task", taskId: task.id, tab: reason === "approval" ? "chat" : "spec" });
});
