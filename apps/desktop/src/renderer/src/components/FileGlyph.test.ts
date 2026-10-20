import { expect, it } from "vitest";
import { fileIcon } from "./FileGlyph";
import { FileCode2, FilePlain, FileText, Image } from "./icons";

it("marks images, other media the panel plays, prose and code each with their own glyph", () => {
  expect(["photo.PNG", "mark.svg", "deck.pdf", "clip.mp4", "tone.mp3", "notes.md", "app.ts", "archive.zip"].map(fileIcon)).toEqual([
    Image,
    Image,
    FilePlain,
    FilePlain,
    FilePlain,
    FileText,
    FileCode2,
    FileCode2,
  ]);
});
