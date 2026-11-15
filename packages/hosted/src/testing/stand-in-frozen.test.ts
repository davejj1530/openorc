import { expect, it } from "vitest";
import { StandInFrozenGate } from "./stand-in-frozen.js";
import { StandInSpaces } from "./stand-in-spaces.js";

const frozen = { state: "frozen", reason: "no_pro", until: null, message: "You need Pro to use an organization. Open Account or ask an admin for a seat." } as const;
function fixture() {
  const spaces = new StandInSpaces();
  const space = spaces.addTeam("Example team", ["admin@example.com", "member@example.com"]);
  const gate = new StandInFrozenGate(spaces);
  const closed = new Set(["admin@example.com", "member@example.com"]);
  gate.access = (who) => (closed.has(who) ? frozen : { state: "active", reason: null, until: null, message: null });
  const status = (who: string, method: string, path: string, at: string | null = space) => gate.refusal({ method, path, space: at }, who)?.status ?? "open";
  return { gate, space, closed, status };
}

it("refuses a frozen person every piece of an organization's content with the contract's envelope", () => {
  const f = fixture();
  for (const [method, path] of [
    ["GET", "/projects"],
    ["POST", "/projects"],
    ["GET", "/projects/p1/access"],
    ["GET", "/hosted/threads"],
    ["GET", "/hosted/threads/t1/events"],
    ["POST", "/hosted/threads/t1/messages"],
    ["GET", "/chat/conversations"],
    ["GET", "/tasks"],
    ["GET", "/github/repositories"],
    ["PATCH", "/organization/members/m1"],
    ["DELETE", "/organization/members/m1"],
    ["DELETE", "/settings/organization"],
  ] as const)
    expect([path, f.status("admin@example.com", method, path)]).toEqual([path, 403]);
  expect(f.gate.refusal({ method: "GET", path: "/projects", space: f.space }, "member@example.com")?.body).toEqual({
    statusCode: 403,
    code: "organization_frozen",
    message: "You need Pro to use this organization. Open Account or ask an admin for a seat.",
    access: frozen,
  });
});

it("keeps leaving for everyone, and the people, invitations, seats and billing for a frozen admin only", () => {
  const f = fixture();
  expect(f.status("member@example.com", "POST", "/organization/leave")).toBe("open");
  for (const [method, path] of [
    ["GET", "/organization/people"],
    ["GET", "/invitations"],
    ["GET", "/organization/billing"],
    ["POST", "/organization/billing/portal"],
    ["PATCH", "/organization/seats/s1"],
    ["GET", "/organization/storage"],
  ] as const) {
    expect([path, f.status("admin@example.com", method, path)]).toEqual([path, "open"]);
    expect([path, f.status("member@example.com", method, path)]).toEqual([path, 403]);
  }
});

it("never closes Personal, a person's own reads, a stranger's request or a person with access", () => {
  const f = fixture();
  expect(f.status("member@example.com", "GET", "/hosted/threads", "personal-member@example.com")).toBe("open");
  expect(f.status("member@example.com", "GET", "/hosted/threads", null)).toBe("open");
  expect(f.status("member@example.com", "GET", "/spaces")).toBe("open");
  expect(f.status("member@example.com", "GET", "/billing")).toBe("open");
  expect(f.status("member@example.com", "GET", "/invitations/received")).toBe("open");
  expect(f.status("stranger@example.com", "GET", "/projects")).toBe("open");
  f.closed.delete("member@example.com");
  expect(f.status("member@example.com", "GET", "/projects")).toBe("open");
});
