import { expect, it } from "vitest";
import { fileReference } from "./file-reference";

it("parses absolute, relative, file URL and Windows citations", () => {
  expect(fileReference("/repo/Conversation.tsx:84")).toEqual({ path: "/repo/Conversation.tsx", line: 84 });
  expect(fileReference("src/Conversation.tsx:84:9", "/repo/worktree")).toEqual({ path: "/repo/worktree/src/Conversation.tsx", line: 84 });
  expect(fileReference("file:///repo/My%20File.tsx#L84-L90")).toEqual({ path: "/repo/My File.tsx", line: 84, endLine: 90 });
  expect(fileReference("C:\\repo\\app.ts:12:4")).toEqual({ path: "C:\\repo\\app.ts", line: 12 });
  expect(fileReference("Conversation.tsx:84")).toEqual({ path: "Conversation.tsx", line: 84 });
  expect(fileReference("/repo/app.ts")).toEqual({ path: "/repo/app.ts" });
});

it("preserves encoded punctuation and rejects unsafe URL routing", () => {
  expect(fileReference("/repo/issue%23L84.ts%3A7#L12")).toEqual({ path: "/repo/issue#L84.ts:7", line: 12 });
  for (const url of ["https://example.com/file.ts#L4", "file://server/code.ts", "//server/code.ts", "javascript:alert(1)", "data:text/plain,hi", "#L4", "/repo/a%00.ts", "/repo/%XX.ts"])
    expect(fileReference(url)).toBeNull();
  expect(fileReference("/repo/a.ts:0")).toEqual({ path: "/repo/a.ts" });
  expect(fileReference("/repo/a.ts#L12-L3")).toEqual({ path: "/repo/a.ts", line: 12 });
});
