import { expect, it } from "vitest";
import { PROTECTED_SECRET_CHANNELS, PROTECTED_SECRET_FILES } from "./protected-secrets";

it("serves the OpenOrc account's session on its own channel, in a file no other channel shares", () => {
  expect(PROTECTED_SECRET_CHANNELS).toContain("account.secrets");
  expect(PROTECTED_SECRET_FILES["account.secrets"]).toBe("openorc-account.enc");
  const files = Object.values(PROTECTED_SECRET_FILES);
  expect(files.filter((file) => file === PROTECTED_SECRET_FILES["account.secrets"])).toHaveLength(1);
  expect(new Set(files).size).toBe(files.length);
});
