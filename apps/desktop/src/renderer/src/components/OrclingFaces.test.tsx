import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ORCLING_SHAPES } from "@openorc/client";
import { defaultOrclingLook } from "@openorc/protocol";

// The live figure's animation needs a real browser; what stands where is the subject here.
vi.mock("./OrclingPreview", () => ({ OrclingPreview: ({ className }: { className?: string }) => <span className={className} /> }));

const { OrclingFaces, OrclingGathering } = await import("./OrclingFaces");

afterEach(cleanup);

const member = (id: string, name: string, shape: number) => ({ id, name, look: { ...defaultOrclingLook, shape } });
const pip = member("pip", "Pip", 4);
const bo = member("bo", "Bo", 0);
const rini = member("rini", "Rini", 1);

it("cuts each face away along the outline of the face in front of it, and leaves the front face whole", () => {
  render(<OrclingFaces members={[pip, bo, rini]} size={24} />);
  const faces = [...screen.getByLabelText("Pip, Bo, Rini").querySelectorAll("svg")];
  expect(faces).toHaveLength(3);
  const cutBy = (face: SVGSVGElement) => face.querySelector("mask path")?.getAttribute("d");
  expect(cutBy(faces[0]!)).toBe(ORCLING_SHAPES[0]!.path);
  expect(cutBy(faces[1]!)).toBe(ORCLING_SHAPES[1]!.path);
  expect(faces[2]!.querySelector("mask")).toBeNull();
  // The cut is a gap in the drawing itself, not a ring painted in the page's color around a square.
  for (const face of faces.slice(0, 2)) expect(face.querySelector("g[mask]")).not.toBeNull();
});

it("stands at most three of a group's members in its empty chat, named for screen readers", () => {
  render(<OrclingGathering members={[pip, bo, rini, member("ash", "Ash", 2)]} />);
  const gathering = screen.getByLabelText("Pip, Bo, Rini, and Ash");
  expect(gathering.querySelectorAll(".orcling-gathering-figure")).toHaveLength(3);
});
