import { describe, expect, it } from "vitest";
import { teamGitActions } from "./team-git-actions";

const allowed = { allowed: true, reason: null };
const ready = { isPending: false, isError: false, data: { actions: { commit: allowed, push: allowed, createPr: allowed } } };

describe("team Git action availability", () => {
  it("fails closed when a previously authorized projection cannot be refreshed", () => {
    expect(Object.values(teamGitActions(true, { ...ready, isError: true })).every((action) => !action.allowed && action.reason?.includes("Retry"))).toBe(true);
    expect(Object.values(teamGitActions(true, { ...ready, isPending: true })).every((action) => !action.allowed)).toBe(true);
    expect(Object.values(teamGitActions(true, { ...ready, data: {} })).every((action) => !action.allowed)).toBe(true);
    expect(Object.values(teamGitActions(true, { ...ready, data: null })).every((action) => !action.allowed)).toBe(true);
  });

  it("does not let an allowed commit authorize publishing before integration is ready", () => {
    const blocked = { allowed: false, reason: "Resolve retained integration details first." };
    const actions = teamGitActions(true, { ...ready, data: { actions: { commit: allowed, push: blocked, createPr: blocked } } });
    expect(actions.commit.allowed).toBe(true);
    expect(actions.push).toEqual(blocked);
    expect(actions.createPr).toEqual(blocked);
    expect(teamGitActions(true, ready)).toEqual(ready.data.actions);
  });

  it("leaves ordinary task Git controls independent of the disabled team query", () => {
    expect(Object.values(teamGitActions(false, { isPending: true, isError: false })).every((action) => action.allowed)).toBe(true);
  });
});
