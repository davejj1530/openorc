import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { queryClient } from "../lib/query";
import { core } from "../lib/rpc";
import { beginTeamDeleteRequest, readTeamDeleteRequest } from "../lib/team-delete-request";
import { TeamRecoveryActions } from "./TeamRecoveryActions";

afterEach(() => {
  cleanup();
  queryClient.clear();
  localStorage.clear();
  vi.restoreAllMocks();
});

it("keeps the exact recovery key after a lost reply, blocks duplicate clicks, then clears only its own request", async () => {
  const request = beginTeamDeleteRequest("thread", undefined, () => "retained-key");
  let fail!: (error: Error) => void;
  const call = vi
    .spyOn(core, "call")
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    )
    .mockResolvedValue({ state: "cancelled" });
  const resolved = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <TeamRecoveryActions id="thread" kind="delete" requestKey={request.requestKey} onResolved={resolved} />
    </QueryClientProvider>,
  );
  const button = screen.getByRole("button", { name: "Cancel delete" });
  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
  fail(new Error("Reply lost"));
  expect((await screen.findByRole("alert")).textContent).toContain("Reply lost");
  expect(readTeamDeleteRequest("thread")).toEqual(request);
  fireEvent.click(button);
  await waitFor(() => expect(resolved).toHaveBeenCalledWith("cancelled"));
  expect(call.mock.calls).toEqual(Array(2).fill(["threads.cancelTeamOperation", { id: "thread", kind: "delete", requestKey: "retained-key" }]));
  expect(readTeamDeleteRequest("thread")).toBeNull();
});

it("uses an explicit keep-files action after partial cleanup", async () => {
  const call = vi.spyOn(core, "call").mockResolvedValue({ state: "applied" });
  const resolved = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <TeamRecoveryActions id="thread" kind="delete" requestKey="delete" canKeepFiles onResolved={resolved} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Finish deletion, keep remaining files" }));
  await waitFor(() => expect(resolved).toHaveBeenCalledWith("applied"));
  expect(call).toHaveBeenCalledWith("threads.cancelTeamOperation", { id: "thread", kind: "delete", requestKey: "delete", keepFiles: true });
});
