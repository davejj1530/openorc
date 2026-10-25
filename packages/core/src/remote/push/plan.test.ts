import { describe, expect, it } from "vitest";
import type { NotifyKind, PushAlerts } from "@openorc/protocol";
import { planAlert, type AlertGroup, type AlertPlan } from "./plan.js";

const NOW = 1_000_000;
const ring = (sound: boolean): AlertPlan => ({ kind: "ring", sound });
const quiet: AlertPlan = { kind: "quiet" };

type Case = [string, NotifyKind | "test", { alerts?: PushAlerts; sound?: boolean; macInUse?: boolean; rang?: [secondsAgo: number, AlertGroup] }, AlertPlan | null];

const cases: Case[] = [
  ["an approval rings a phone that takes everything", "approval", {}, ring(true)],
  ["a finished turn rings a phone that takes everything", "finished", {}, ring(true)],
  ["a phone without sound rings silently", "error", { sound: false }, ring(false)],
  ["a phone that takes needs-you hears a question", "question", { alerts: "needs-you" }, ring(true)],
  ["a phone that takes needs-you hears nothing of an outcome", "finished", { alerts: "needs-you" }, null],
  ["a phone that takes needs-you hears nothing of a schedule", "schedule", { alerts: "needs-you" }, null],
  ["at the Mac, an outcome is not sent", "task", { macInUse: true }, null],
  ["at the Mac, an approval waits quietly", "approval", { macInUse: true }, quiet],
  ["at the Mac, a question waits quietly even without sound", "question", { macInUse: true, sound: false }, quiet],
  ["an outcome after a ring in the last minute is quiet", "finished", { rang: [30, "outcome"] }, quiet],
  ["an outcome after an approval's ring in the last minute is quiet", "error", { rang: [59, "needs-you"] }, quiet],
  ["an approval after a finished turn's ring always rings", "approval", { rang: [5, "outcome"] }, ring(true)],
  ["an approval after an approval within 60 s is quiet", "approval", { rang: [10, "needs-you"] }, quiet],
  ["a ring a minute ago no longer quiets anything", "finished", { rang: [60, "outcome"] }, ring(true)],
  ["the test notice always rings, at the Mac too", "test", { macInUse: true, rang: [1, "needs-you"] }, ring(true)],
  ["the test notice reaches a needs-you phone, with its sound choice", "test", { alerts: "needs-you", sound: false }, ring(false)],
];

describe("planAlert", () => {
  it.each(cases)("%s", (_name, kind, { alerts = "all", sound = true, macInUse = false, rang }, plan) => {
    const lastRing = rang ? { at: NOW - rang[0] * 1000, group: rang[1] } : null;
    expect(planAlert({ kind, threadId: kind === "test" ? null : "thread" }, { alerts, sound }, { macInUse, lastRing, now: NOW })).toEqual(plan);
  });
});
