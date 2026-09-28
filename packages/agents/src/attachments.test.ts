import { expect, it } from "vitest";
import { partitionAttachments, withAttachedFiles } from "./attachments";

it("sends pictures as picture input and names every other file for the agent to open", () => {
  const { images, files } = partitionAttachments(["/data/attachments/a.png", "/data/attachments/b-Notes.PDF", "/data/attachments/c.JPEG", "/data/attachments/d-rows.csv", "/data/attachments/e"]);
  expect(images).toEqual(["/data/attachments/a.png", "/data/attachments/c.JPEG"]);
  expect(files).toEqual(["/data/attachments/b-Notes.PDF", "/data/attachments/d-rows.csv", "/data/attachments/e"]);
});

it("leaves the prompt alone when nothing needs opening", () => {
  expect(partitionAttachments(undefined)).toEqual({ images: [], files: [] });
  expect(withAttachedFiles("Review this", [], "open them to read")).toBe("Review this");
});

it("lists the files under the prompt with the provider's own instruction", () => {
  expect(withAttachedFiles("Review this", ["/tmp/a.csv"], "open them to read")).toBe("Review this\n\nAttached file (open them to read):\n- /tmp/a.csv");
  expect(withAttachedFiles("Review this", ["/tmp/a.csv", "/tmp/b.pdf"], "open with the Read tool")).toBe("Review this\n\nAttached files (open with the Read tool):\n- /tmp/a.csv\n- /tmp/b.pdf");
});
