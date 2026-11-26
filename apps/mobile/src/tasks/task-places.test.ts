import type { BoardColumn } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { placedAt, placePatch, taskPlace, taskPlaces } from "./task-places";

const column = (id: string, name: string, stage: BoardColumn["stage"]) => ({ id, name, stage });
const board = [column("plan", "Plan", "backlog"), column("build", "Build", "in_progress"), column("check", "Code review", "review"), column("ship", "Done", "done")];
const names = (columns: Parameters<typeof taskPlaces>[0]) => taskPlaces(columns).map((place) => place.name);

describe("a task's Status menu", () => {
  it("offers the statuses where the project keeps no columns, or the Mac shares none", () => {
    expect(names([])).toEqual(["Proposed", "Backlog", "In progress", "Review", "Done", "Archived"]);
  });

  it("lists the board's columns in its order, with a proposal before them and the archive after", () => {
    expect(names(board)).toEqual(["Proposed", "Plan", "Build", "Code review", "Done", "Archived"]);
    expect(names([column("a", "Build", "in_progress"), column("b", "Build again", "in_progress"), column("c", "Ship", "done")])).toEqual([
      "Proposed",
      "Backlog",
      "Build",
      "Build again",
      "Review",
      "Ship",
      "Archived",
    ]);
  });

  it("places a stage the board has no column for before the first column of a later stage, as the board draws it", () => {
    expect(names([column("ship", "Shipped", "done"), column("plan", "Plan", "backlog")])).toEqual(["Proposed", "In progress", "Review", "Shipped", "Plan", "Archived"]);
  });

  it("shows the task in its own column, else in the first column of its status", () => {
    const places = taskPlaces([...board, column("build-2", "Build again", "in_progress")]);
    expect(taskPlace({ status: "in_progress", columnId: "build-2" }, places).name).toBe("Build again");
    expect(taskPlace({ status: "in_progress", columnId: null }, places).name).toBe("Build");
    // A column since removed from the board.
    expect(taskPlace({ status: "review", columnId: "gone" }, places).name).toBe("Code review");
    expect(taskPlace({ status: "archived", columnId: null }, places).name).toBe("Archived");
  });

  it("saves a column by its id and a status no column stands for as the status, showing the column's stage meanwhile", () => {
    const places = taskPlaces(board);
    const review = places.find((place) => place.name === "Code review")!;
    expect(placePatch(review)).toEqual({ columnId: "check" });
    expect(placedAt(review)).toEqual({ status: "review", columnId: "check" });
    const archived = places.find((place) => place.name === "Archived")!;
    expect(placePatch(archived)).toEqual({ status: "archived" });
    expect(placedAt(archived)).toEqual({ status: "archived", columnId: null });
    expect(placePatch(taskPlaces([]).find((place) => place.name === "Review")!)).toEqual({ status: "review" });
  });
});
