import type { PlanLimits } from "@openorc/protocol";
import { expect, it } from "vitest";
import { cloudAccount, macAccount } from "./usage-account";

const limits = (id: string, provider: PlanLimits["provider"]): PlanLimits => ({ id, provider, name: id, plan: null, status: "available", windows: [], refreshedAt: null });

it("measures the Mac's account an agent runs on: its own, or the Claude account named", () => {
  const accounts = [limits("codex", "codex"), limits("claude:work", "claude"), limits("claude:home", "claude")];
  expect(macAccount(accounts, "codex", undefined)?.id).toBe("codex");
  expect(macAccount(accounts, "claude", "home")?.id).toBe("claude:home");
  // Which of several Claude accounts is not known yet: none is shown, never another account's usage.
  expect(macAccount(accounts, "claude", undefined)).toBeNull();
  expect(macAccount(accounts, "opencode", undefined)).toBeNull();
});

it("takes the Mac's only Claude account whatever it is called, as a Mac with one account names none", () => {
  expect(macAccount([limits("claude:only", "claude")], "claude", undefined)?.id).toBe("claude:only");
  expect(macAccount([limits("claude:only", "claude")], "claude", "gone")?.id).toBe("claude:only");
});

it("measures the person's account on OpenOrc Cloud for the agent: the one named, else its only sign-in there", () => {
  const accounts = [limits("cloud:claude:personal", "claude"), limits("cloud:claude:work", "claude"), limits("cloud:codex", "codex")];
  expect(cloudAccount(accounts, "claude", "work")?.id).toBe("cloud:claude:work");
  expect(cloudAccount(accounts, "claude", undefined)).toBeNull();
  expect(cloudAccount(accounts, "codex", undefined)?.id).toBe("cloud:codex");
});
