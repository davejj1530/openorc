import type { SpacesStatus } from "@openorc/protocol";

export function taskAccess(accountId = "account-a", spaceId = "org:studio"): Extract<SpacesStatus, { state: "ready" }> {
  return {
    state: "ready",
    userId: accountId,
    apiOrigin: "https://example.com",
    personalSpaceId: "personal-a",
    spaces: [{ id: spaceId, kind: "organization", name: "Example team", logo: null, memberId: "member-a", role: "member", memberCount: 2 }],
    organizationAccess: { state: "active", reason: null, until: null, message: null },
    create: { allowed: true, reason: null },
    invitations: [],
    reach: "live",
    heardAt: Date.now(),
    error: null,
  };
}
