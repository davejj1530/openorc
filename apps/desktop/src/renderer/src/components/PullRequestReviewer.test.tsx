import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultOrclingLook, type ModelCatalog, type PullRequestDetail, type RpcMethod, type RpcResults } from "@openorc/protocol";
import { core } from "../lib/rpc";
import { queryClient } from "../lib/client";
import { PullRequestReviewer } from "./PullRequestReviewer";

const pull = { number: 7, title: "Add retries", url: "https://github.com/acme/app/pull/7", headSha: "c".repeat(40), body: "" } as PullRequestDetail;
const mac: ModelCatalog = { models: [{ id: "claude-sonnet-5", label: "Sonnet 5", agent: "claude", isDefault: true, efforts: [], defaultEffort: null }], providers: [] };
const cloud: ModelCatalog = {
  models: [
    { id: "", label: "Claude Code default", agent: "claude", isDefault: true, efforts: [], defaultEffort: null },
    { id: "gpt-5.5", label: "GPT-5.5", agent: "codex", isDefault: true, efforts: [], defaultEffort: null },
  ],
  providers: [],
};
let rootPath: string;

beforeEach(() => {
  rootPath = "";
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } });
  // The last reviewer chosen, on a Mac project: a Mac model, by way of an Orcling.
  localStorage.setItem("openorc.pull-reviewer", JSON.stringify({ kind: "model", choice: { agent: "claude", model: "claude-sonnet-5", effort: null }, orclingId: "rook" }));
  vi.spyOn(core, "call").mockImplementation(async <M extends RpcMethod>(method: M): Promise<RpcResults[M]> => {
    if (method === "projects.get") return { id: "project", name: "app", rootPath, gitRemote: "https://github.com/acme/app" } as RpcResults[M];
    if (method === "cloudModels.catalog") return cloud as RpcResults[M];
    if (method === "agents.modelCatalog") return mac as RpcResults[M];
    if (method === "orclings.list")
      return [{ id: "rook", name: "Rook", look: defaultOrclingLook, settings: { agent: "claude", model: "claude-sonnet-5", effort: null, fastMode: false } }] as RpcResults[M];
    if (method === "pulls.review.start") return { threadId: "review" } as RpcResults[M];
    if (method === "system.info" || method === "app.settings.get" || method === "threads.get") return null as RpcResults[M];
    return [] as unknown as RpcResults[M];
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  localStorage.clear();
  vi.restoreAllMocks();
});

const started = () =>
  vi
    .mocked(core.call)
    .mock.calls.filter(([method]) => method === "pulls.review.start")
    .map(([, params]) => params);

it("reviews a project only OpenOrc Cloud has with a model the cloud runs, and no Orcling", async () => {
  render(
    <QueryClientProvider client={queryClient}>
      <PullRequestReviewer projectId="project" pull={pull} review={null} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByRole("button", { name: "Reviewer" }).textContent).toContain("Claude Code default"));
  fireEvent.click(screen.getByRole("button", { name: /Start review/ }));
  await waitFor(() => expect(started()).toEqual([{ projectId: "project", number: 7, reviewer: { agent: "claude", model: "", effort: null, fastMode: false } }]));
});

it("keeps the reviewer last chosen for a project on this Mac", async () => {
  rootPath = "/work/app";
  render(
    <QueryClientProvider client={queryClient}>
      <PullRequestReviewer projectId="project" pull={pull} review={null} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByRole("button", { name: "Reviewer" }).textContent).toContain("Rook"));
  fireEvent.click(screen.getByRole("button", { name: /Start review/ }));
  await waitFor(() => expect(started()).toEqual([{ projectId: "project", number: 7, reviewer: { agent: "claude", model: "claude-sonnet-5", effort: null, fastMode: false }, orclingId: "rook" }]));
});
