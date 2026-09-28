import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PullRequestDetail, RpcMethod, RpcParams, RpcResults } from "@openorc/protocol";
import type { CommentDraft, CommentLocation } from "../components/DiffView";
import { core } from "../lib/rpc";
import { invalidateTags, queryClient } from "../lib/query";
import { PullRequestView } from "./PullRequestView";

/** The diff viewer's own rendering is covered elsewhere; this test drives the comment it asks for. */
const viewer = vi.hoisted(() => ({
  props: null as null | { patch: string; draft: CommentDraft | null; onRequestComment?: (location: CommentLocation) => void; onSubmitDraft?: (body: string) => void },
}));
vi.mock("../components/DiffView", () => ({
  DiffView: (props: NonNullable<typeof viewer.props>) => {
    viewer.props = props;
    return <div data-testid="diff" />;
  },
}));
vi.mock("../components/PullRequestReviewer", () => ({ PullRequestReviewer: () => null }));
vi.mock("../components/PullRequestReviewBar", () => ({ PullRequestReviewBar: () => null }));
vi.mock("../components/TopBar", () => ({ TopBar: () => null }));

const commit = (letter: string) => letter.repeat(40);
const patchAt = (letter: string) => ["diff --git a/app.ts b/app.ts", "--- a/app.ts", "+++ b/app.ts", "@@ -1,1 +1,1 @@", "-const a = 0;", `+const a = "${letter}";`].join("\n");
const pull = { number: 7, title: "Add retries", url: "https://github.com/acme/app/pull/7", headSha: commit("c"), body: "" } as PullRequestDetail;

let head: string;
beforeEach(() => {
  head = "a";
  viewer.props = null;
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } });
  vi.spyOn(core, "call").mockImplementation(async <M extends RpcMethod>(method: M): Promise<RpcResults[M]> => {
    if (method === "pulls.get") return pull as RpcResults[M];
    if (method === "pulls.diff") return { patch: patchAt(head), headSha: commit(head) } as RpcResults[M];
    if (method === "pulls.review.get" || method === "projects.get") return null as RpcResults[M];
    return [] as unknown as RpcResults[M];
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});

it("comments on the commit whose diff the comment was started on, after the diff refreshes", async () => {
  render(
    <QueryClientProvider client={queryClient}>
      <PullRequestView projectId="project" number={7} />
    </QueryClientProvider>,
  );
  await screen.findByTestId("diff");
  const location: CommentLocation = { path: "app.ts", startLine: null, startSide: null, line: 1, side: "new", lineText: 'const a = "a";' };
  act(() => viewer.props!.onRequestComment!(location));

  // A push lands while the comment is being written, and the diff refreshes beneath it.
  head = "b";
  act(() => invalidateTags(["pulls"], { immediate: true }));
  await waitFor(() => expect(viewer.props!.patch).toBe(patchAt("b")));
  expect(viewer.props!.draft).toEqual(location);
  act(() => viewer.props!.onSubmitDraft!("Name this constant."));

  await waitFor(() =>
    expect(core.call).toHaveBeenCalledWith("pulls.review.comment", {
      projectId: "project",
      number: 7,
      commitId: commit("a"),
      ...location,
      body: "Name this constant.",
    } satisfies RpcParams<"pulls.review.comment">),
  );
});
