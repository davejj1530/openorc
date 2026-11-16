import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { PULL_REVIEW_NEEDS_FOLDER, type PullRequestDetail } from "@openorc/protocol";
import { queryClient } from "../lib/client";
import { PullRequestReviewer } from "./PullRequestReviewer";

afterEach(cleanup);

it("holds Review for a project with no folder on this Mac, saying why on demand and offering no reviewer", () => {
  render(
    <QueryClientProvider client={queryClient}>
      <PullRequestReviewer projectId="cloud-project" pull={{ number: 7 } as PullRequestDetail} review={null} held={PULL_REVIEW_NEEDS_FOLDER} />
    </QueryClientProvider>,
  );
  const review = screen.getByRole("button", { name: /Start review/ });
  expect(review.hasAttribute("disabled")).toBe(true);
  expect(review.getAttribute("data-tip")).toBe(PULL_REVIEW_NEEDS_FOLDER);
  expect(screen.queryByText(PULL_REVIEW_NEEDS_FOLDER)).toBeNull();
  expect(screen.queryByText("Reviewer")).toBeNull();
});
