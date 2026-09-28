import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { removeAcceptedAttachments, useComposerAttachments } from "./composer-attachments";
import { readDraft, writeDraft } from "./drafts";

const imports = vi.hoisted(() => ({ image: vi.fn(), file: vi.fn() }));
vi.mock("./image-imports", () => ({ importImage: imports.image }));
vi.mock("./file-imports", () => ({ importFile: imports.file, isImageAttachment: (file: File) => file.type.startsWith("image/") }));

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.resetAllMocks();
});

it.each([false, true])("retains an import resolved after unmount (reopened first: %s)", async (reopenedFirst) => {
  let finish!: (value: { path: string; url: string }) => void;
  imports.image.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const draftKey = "upload-navigation";
  const first = renderHook(() => useComposerAttachments({ draftKey }));
  let importing!: Promise<void>;
  act(() => {
    importing = first.result.current.addFiles([new File(["image"], "picture.png", { type: "image/png" })]);
  });
  first.unmount();
  const reopened = reopenedFirst ? renderHook(() => useComposerAttachments({ draftKey })) : null;
  if (reopened) expect(reopened.result.current.uploading).toBe(1);
  await act(async () => {
    finish({ path: "/assets/picture.png", url: "asset://picture" });
    await importing;
  });
  expect(readDraft(draftKey, { attachments: [] }).attachments).toMatchObject([{ path: "/assets/picture.png" }]);
  const current = reopened ?? renderHook(() => useComposerAttachments({ draftKey }));
  expect(current.result.current.attachments).toMatchObject([{ name: "picture.png", path: "/assets/picture.png" }]);
  expect(current.result.current.uploading).toBe(0);
});

it("keeps a failed import visible after navigation and allows a later retry", async () => {
  let reject!: (reason: Error) => void;
  imports.file.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const draftKey = "upload-failure";
  const file = new File(["notes"], "notes.txt", { type: "text/plain" });
  const first = renderHook(() => useComposerAttachments({ draftKey }));
  let importing!: Promise<void>;
  act(() => {
    importing = first.result.current.addFiles([file]);
  });
  first.unmount();
  await act(async () => {
    reject(new Error("Storage unavailable"));
    await importing;
  });
  const reopened = renderHook(() => useComposerAttachments({ draftKey }));
  expect(reopened.result.current.error).toContain("Storage unavailable");
  expect(reopened.result.current.uploading).toBe(0);
  imports.file.mockResolvedValue({ path: "/assets/notes.txt" });
  await act(async () => {
    reopened.result.current.clearError();
    await reopened.result.current.addFiles([file]);
  });
  expect(reopened.result.current.error).toBeNull();
  expect(reopened.result.current.attachments).toMatchObject([{ path: "/assets/notes.txt" }]);
});

it("removes accepted paths without losing files added after submission", () => {
  const draftKey = "accepted-files";
  writeDraft(draftKey, {
    attachments: [
      { path: "/old", name: "old", url: null },
      { path: "/new", name: "new", url: null },
    ],
  });
  const { result } = renderHook(() => useComposerAttachments({ draftKey }));
  act(() => removeAcceptedAttachments(draftKey, ["/old"]));
  expect(result.current.attachments.map((item) => item.path)).toEqual(["/new"]);
  expect(readDraft(draftKey, { attachments: [] }).attachments).toMatchObject([{ path: "/new" }]);
});
