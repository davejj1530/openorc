import { expect, it } from "vitest";
import { isRemoteMethod, rpcParams } from "@openorc/protocol";
import { createSpacesHandlers } from "./spaces.js";

it("answers unavailable without inventing a personal organization", () => {
  const handlers = createSpacesHandlers(null);
  expect(handlers["spaces.status"]({})).toEqual({ state: "unavailable" });
  expect(() => handlers["spaces.projects"]({ spaceId: "org" })).toThrow("OpenOrc accounts aren't available here.");
});

it("keeps organization methods off the phone and validates scope and pagination at dispatch", () => {
  for (const method of [
    "spaces.status",
    "spaces.projects",
    "organization.people",
    "organization.leave",
    "organization.delete",
    "organization.member.setRole",
    "organization.member.remove",
    "organization.project.access",
    "organization.project.setAccess",
    "organization.invitations",
    "organization.invite",
    "organization.invitation.resend",
    "organization.invitation.revoke",
  ])
    expect(isRemoteMethod(method)).toBe(false);
  expect(rpcParams["spaces.projects"].safeParse({ spaceId: "" }).success).toBe(false);
  expect(rpcParams["organization.people"].safeParse({ spaceId: "org", limit: 101 }).success).toBe(false);
  expect(rpcParams["organization.people"].safeParse({ spaceId: "org", offset: 0, limit: 100 }).success).toBe(true);
  expect(rpcParams["organization.member.setRole"].safeParse({ spaceId: "org", memberId: "member", role: "owner" }).success).toBe(false);
  expect(rpcParams["organization.member.remove"].safeParse({ spaceId: "org", memberId: "" }).success).toBe(false);
  expect(rpcParams["organization.project.setAccess"].safeParse({ spaceId: "org", projectId: "project", everyone: false, memberIds: ["member", "member"] }).success).toBe(false);
  expect(rpcParams["organization.invite"].safeParse({ spaceId: "org", emails: Array(31).fill("person@example.com"), role: "member" }).success).toBe(false);
  expect(rpcParams["organization.invite"].safeParse({ spaceId: "org", emails: ["person@example.com"], role: "owner" }).success).toBe(false);
});
