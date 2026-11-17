import { WORKSPACE_ID, type Space, type SpaceProject } from "@openorc/protocol";
import { expect, it } from "vitest";
import { spaceChoices } from "./projects";

const personal: Space = { id: "personal-me", kind: "personal" };
const birch: Space = { id: "org-birch", kind: "organization", name: "Birch Studio", logo: null, memberId: "member-me", role: "member", memberCount: 2 };
const projects: SpaceProject[] = [
  { key: "sketchbook", name: "sketchbook", repo: null, localProjectId: "p-mac", hostedProjectId: null, connected: true },
  { key: "canvas", name: "canvas", repo: "birch/canvas", localProjectId: "p-both", hostedProjectId: "h-both", connected: true },
  { key: "cloud-project:h-notes", name: "notes-app", repo: "riley/notes-app", localProjectId: null, hostedProjectId: "h-notes", connected: true },
];

it("offers a space's projects as Home groups them: a folder of the Mac's by its id, one only OpenOrc Cloud has with its space", () => {
  expect(spaceChoices(personal, projects)).toEqual([
    { id: WORKSPACE_ID, name: "Workspace" },
    { id: "p-mac", name: "sketchbook" },
    { id: "p-both", name: "canvas" },
    { id: "cloud-project:h-notes", name: "notes-app", cloud: { spaceId: "personal-me" } },
  ]);
  // An organization has no Workspace of the Mac's.
  expect(spaceChoices(birch, projects).map((choice) => choice.id)).toEqual(["p-mac", "p-both", "cloud-project:h-notes"]);
  expect(spaceChoices(birch, projects).at(-1)).toMatchObject({ cloud: { spaceId: "org-birch" } });
});
