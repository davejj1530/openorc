import { describe, expect, it, vi } from "vitest";
import { prepareTeamSendRequest, restoreTeamSendRequest } from "./team-send-request";

describe("team send request recovery", () => {
  it("retains live delivery and identity across reload and a normal Enter retry", () => {
    const first = prepareTeamSendRequest({ previous: null, body: "Use this image", attachments: ["/images/design.png"], deliverNow: true, createKey: () => "accepted-key" });
    const restored = restoreTeamSendRequest(JSON.parse(JSON.stringify(first)));
    const create = vi.fn(() => "duplicate-key");
    expect(prepareTeamSendRequest({ previous: restored, body: first.body, attachments: ["/images/design.png"], deliverNow: false, createKey: create })).toEqual(first);
    expect(create).not.toHaveBeenCalled();
  });
  it("assigns a fresh identity only when the message or attachments change", () => {
    const first = prepareTeamSendRequest({ previous: null, body: "First", attachments: [], deliverNow: true, createKey: () => "first" });
    expect(prepareTeamSendRequest({ previous: first, body: "Second", attachments: [], deliverNow: false, createKey: () => "second" })).toMatchObject({ key: "second", now: false });
    expect(prepareTeamSendRequest({ previous: first, body: "First", attachments: ["/images/new.png"], deliverNow: false, createKey: () => "image" })).toMatchObject({ key: "image", now: false });
    expect(restoreTeamSendRequest({ ...first, now: "true" })).toBeNull();
  });
});
