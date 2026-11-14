import { expect, it } from "vitest";
import { isRemoteMethod, rpcParams } from "@openorc/protocol";
import { createSpacesHandlers } from "./spaces.js";

it("answers unavailable without inventing a personal organization", () => {
  const handlers = createSpacesHandlers(null);
  expect(handlers["spaces.status"]({})).toEqual({ state: "unavailable" });
  expect(() => handlers["spaces.projects"]({ spaceId: "org" })).toThrow("OpenOrc accounts aren't available here.");
});

it("keeps organization methods off the phone and validates scope and pagination at dispatch", () => {
  for (const method of ["spaces.status", "spaces.projects", "organization.people"]) expect(isRemoteMethod(method)).toBe(false);
  expect(rpcParams["spaces.projects"].safeParse({ spaceId: "" }).success).toBe(false);
  expect(rpcParams["organization.people"].safeParse({ spaceId: "org", limit: 101 }).success).toBe(false);
  expect(rpcParams["organization.people"].safeParse({ spaceId: "org", offset: 0, limit: 100 }).success).toBe(true);
});
