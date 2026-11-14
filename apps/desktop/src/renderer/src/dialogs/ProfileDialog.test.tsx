import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { accountRpcParams, type AccountStatus } from "@openorc/protocol";
import { AccountSettings } from "../views/settings-account";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { identityPicture } from "../lib/identity-picture";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onPush: () => () => {}, onReady: () => () => {} } }));
vi.mock("../lib/identity-picture", () => ({ identityPicture: vi.fn() }));
const picture = "data:image/webp;base64,UklGRg==";
let account: Extract<AccountStatus, { state: "signed-in" }>;
let refusal: string | null;
let readsFail: boolean;
beforeEach(() => {
  queryClient.clear();
  vi.clearAllMocks();
  refusal = null;
  readsFail = false;
  account = {
    state: "signed-in",
    email: "alex@example.com",
    name: "Alex Rivera",
    image: null,
    reach: "live",
    plan: { pro: false },
    hours: null,
    sandbox: null,
    signIns: null,
    signingIn: {},
    github: null,
    connectingGithub: null,
    projects: [],
    paying: null,
    error: null,
  };
  vi.mocked(core.call).mockImplementation(async (method, input) => {
    if (method === "account.offers") return null;
    if (method === "account.profile.update") {
      if (refusal) throw Error(refusal);
      account = { ...account, ...accountRpcParams["account.profile.update"].parse(input) };
      return account;
    }
    if (readsFail) throw Error("OpenOrc Cloud can't be reached.");
    return account;
  });
  vi.mocked(identityPicture).mockResolvedValue(picture);
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});
async function show() {
  render(
    <QueryClientProvider client={queryClient}>
      <AccountSettings active />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  await screen.findByRole("dialog", { name: "Edit profile" });
}

it("keeps an unchanged or empty form disabled and saves only the changed name", async () => {
  await show();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save changes" }).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "" } });
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save changes" }).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alex Lee" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(core.call).toHaveBeenCalledWith("account.profile.update", { name: "Alex Lee" });
  expect(screen.getByRole("heading", { name: "Alex Lee" })).toBeTruthy();
});

it("keeps the server's exact refusal and draft ready for a corrected save", async () => {
  refusal = "Use a name, not a link or a web address.";
  await show();
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  expect((await screen.findByRole("alert")).textContent).toBe(refusal);
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Name" }).value).toBe("example.com");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save changes" }).disabled).toBe(false);
  refusal = null;
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alex Lee" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("crops the picked file with the shared picture reader and sends removal explicitly", async () => {
  await show();
  const file = new File(["pixels"], "portrait.png", { type: "image/png" });
  fireEvent.change(screen.getByLabelText("Profile picture"), { target: { files: [file] } });
  await screen.findByRole("button", { name: "Remove" });
  expect(identityPicture).toHaveBeenCalledWith(file);
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(core.call).toHaveBeenCalledWith("account.profile.update", { image: picture });
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(core.call).toHaveBeenCalledWith("account.profile.update", { image: null }));
});

it("finishes a saved profile from its reply even if a subsequent account read fails", async () => {
  await show();
  readsFail = true;
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alex Lee" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(vi.mocked(core.call).mock.calls.filter(([method]) => method === "account.profile.update")).toHaveLength(1);
  expect(queryClient.getQueryData(["account.status", {}])).toMatchObject({ name: "Alex Lee" });
});
