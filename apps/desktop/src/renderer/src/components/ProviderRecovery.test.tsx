import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { harnessCatalog } from "@openorc/protocol";
import { useRouter } from "../lib/router";
import { runInTerminal } from "../lib/terminal-requests";
import { SignInRecovery } from "./SignInRecovery";
import { UsageRecovery } from "./UsageRecovery";

vi.mock("./ThreadImages", () => ({ useThreadMedia: () => ({ fileScope: { kind: "thread", id: "thread" } }) }));
vi.mock("../lib/claude-account", () => ({ useClaudeAccountId: () => null }));
vi.mock("../lib/terminal-requests", () => ({ runInTerminal: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it.each(["opencode", "omp", "cursor", "pi", "antigravity", "fx"] as const)("uses %s's sign-in command and usage settings", (provider) => {
  render(
    <>
      <SignInRecovery provider={provider} />
      <UsageRecovery provider={provider} />
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(runInTerminal).toHaveBeenCalledExactlyOnceWith({ kind: "thread", id: "thread" }, harnessCatalog[provider].loginCommand);
  if (provider === "pi") expect(screen.getByText("/login")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Manage usage" }));
  expect(useRouter.getState().route).toMatchObject({ view: "settings", section: "usage", provider });
});
