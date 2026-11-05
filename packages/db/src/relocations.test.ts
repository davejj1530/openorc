import { describe, expect, it } from "vitest";
import { Db } from "./database.js";
import { FROZEN, GONE_WORDS, frozenMoving, nextPhase, relocations, type CoordinatorRelocation, type StepOutcome } from "./relocations.js";

const OUTCOMES: StepOutcome[] = [
  { kind: "sent" },
  { kind: "received" },
  { kind: "dropped" },
  { kind: "refused", reason: "No copy of the project." },
  { kind: "imported" },
  { kind: "left" },
  { kind: "stayed" },
  { kind: "kept" },
  { kind: "gone" },
  { kind: "unreachable" },
];
const PHASES = { "to-cloud": ["frozen", "sending", "done", "abandoned"], "to-mac": ["asking", "received", "done", "abandoned"] } as const;

const row = (direction: "to-cloud" | "to-mac", phase: string): CoordinatorRelocation =>
  ({ id: "r", threadId: "t", role: "coordinator", direction, phase, projectId: null, error: null, createdAt: 0, updatedAt: 0 }) as CoordinatorRelocation;

/** What every coordinator pair leads to; a pair absent here keeps its phase. */
const EXPECTED: Record<string, string> = {
  "to-cloud/frozen/sent": "sending",
  "to-cloud/frozen/refused": "abandoned",
  "to-cloud/frozen/gone": "abandoned",
  "to-cloud/frozen/kept": "abandoned",
  "to-cloud/sending/received": "done",
  "to-cloud/sending/refused": "abandoned",
  "to-cloud/sending/dropped": "abandoned",
  "to-cloud/sending/gone": "abandoned",
  "to-mac/asking/imported": "received",
  "to-mac/asking/refused": "abandoned",
  "to-mac/asking/stayed": "abandoned",
  "to-mac/asking/gone": "abandoned",
  "to-mac/received/left": "done",
  "to-mac/received/gone": "done",
};

describe("nextPhase", () => {
  for (const direction of ["to-cloud", "to-mac"] as const)
    for (const phase of PHASES[direction])
      for (const outcome of OUTCOMES) {
        const key = `${direction}/${phase}/${outcome.kind}`;
        it(key, () => expect(nextPhase(row(direction, phase), outcome).phase).toBe(EXPECTED[key] ?? phase));
      }

  it("never unfreezes a thread the brain may have taken", () => {
    const leaving = OUTCOMES.filter((outcome) => nextPhase(row("to-cloud", "sending"), outcome).phase !== "sending").map((outcome) => outcome.kind);
    expect(leaving.sort()).toEqual(["dropped", "gone", "received", "refused"]);
  });

  it("names why a move ended without moving", () => {
    expect(nextPhase(row("to-cloud", "sending"), { kind: "refused", reason: "No Claude account." })).toEqual({ phase: "abandoned", error: "No Claude account." });
    expect(nextPhase(row("to-mac", "asking"), { kind: "gone" })).toEqual({ phase: "abandoned", error: GONE_WORDS });
    expect(nextPhase(row("to-mac", "received"), { kind: "gone" })).toEqual({ phase: "done", error: null });
    expect(nextPhase(row("to-cloud", "frozen"), { kind: "kept" })).toEqual({ phase: "abandoned", error: null });
  });
});

describe("the journal", () => {
  it("allows one open relocation per thread, and moves a row on only from the phase seen", () => {
    const db = Db.memory();
    relocations.open(db, { id: "a", threadId: "t", role: "coordinator", direction: "to-cloud", phase: "frozen", projectId: "p" });
    expect(() => relocations.open(db, { id: "b", threadId: "t", role: "coordinator", direction: "to-mac", phase: "asking", projectId: "p" })).toThrow();
    expect(relocations.advance(db, "a", "sending", "done")).toBe(false);
    expect(relocations.advance(db, "a", "frozen", "sending")).toBe(true);
    expect(relocations.unsettled(db).map((each) => each.phase)).toEqual(["sending"]);
    expect(relocations.advance(db, "a", "sending", "done")).toBe(true);
    expect(relocations.unsettled(db)).toEqual([]);
    relocations.open(db, { id: "b", threadId: "t", role: "coordinator", direction: "to-mac", phase: "asking", projectId: "p" });
    expect(relocations.openFor(db, "t")?.id).toBe("b");
  });

  it("refuses a phase that does not belong to the row's role and direction", () => {
    const db = Db.memory();
    expect(() => relocations.open(db, { id: "a", threadId: "t", role: "brain", direction: "to-cloud", phase: "frozen" as never, projectId: null })).toThrow();
  });

  it("freezes exactly the phases FROZEN names", () => {
    const db = Db.memory();
    const cases = [
      ["coordinator", "to-cloud", "frozen", "cloud"],
      ["coordinator", "to-cloud", "sending", "cloud"],
      ["coordinator", "to-mac", "asking", null],
      ["coordinator", "to-mac", "received", null],
      ["brain", "to-mac", "leaving", "mac"],
      ["brain", "to-mac", "stayed", null],
      ["brain", "to-cloud", "arrived", null],
    ] as const;
    cases.forEach(([role, direction, phase], index) => relocations.open(db, { id: `r${index}`, threadId: `t${index}`, role, direction, phase, projectId: null }));
    expect(cases.map((_, index) => frozenMoving(db, `t${index}`)?.to ?? null)).toEqual(cases.map(([, , , to]) => to));
    expect([...FROZEN["coordinator/to-cloud"]].sort()).toEqual(["frozen", "sending"]);
  });
});
