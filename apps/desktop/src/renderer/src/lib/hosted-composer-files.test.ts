import type { HostedDraftFile } from "@openorc/protocol";
import { describe, expect, it } from "vitest";
import { hostedFileReasons } from "./hosted-composer-files";

const file = (state: HostedDraftFile["state"]): HostedDraftFile => ({ id: crypto.randomUUID(), name: "notes.pdf", bytes: 10, mime: "application/pdf", selectedAt: 1, imported: 10, state });
const ready = file({ kind: "ready", file: { id: "f1", name: "notes.pdf", bytes: 10, kind: "file", contentType: "application/pdf" } });
const base = { scope: true, availability: { available: true as const }, availabilityError: null, files: [] as HostedDraftFile[], loading: false };

describe("a cloud composer's file reasons", () => {
  it("never stops words from sending when no file is in the draft, whatever the files feature says", () => {
    expect(hostedFileReasons(base).send).toBeNull();
    expect(hostedFileReasons({ ...base, scope: false, availability: undefined }).send).toBeNull();
    expect(hostedFileReasons({ ...base, availability: { available: false, reason: "Files can't be sent to OpenOrc Cloud yet." } }).send).toBeNull();
    expect(hostedFileReasons({ ...base, availabilityError: new Error("OpenOrc Cloud can't be reached.") }).send).toBeNull();
  });

  it("says why attaching is off: the server's reason, its failure, or the check still under way", () => {
    expect(hostedFileReasons(base).attach).toBeNull();
    expect(hostedFileReasons({ ...base, availability: { available: false, reason: "Files can't be sent to OpenOrc Cloud yet." } }).attach).toBe("Files can't be sent to OpenOrc Cloud yet.");
    expect(hostedFileReasons({ ...base, availabilityError: new Error("OpenOrc Cloud can't be reached.") }).attach).toBe("OpenOrc Cloud can't be reached.");
    expect(hostedFileReasons({ ...base, availability: undefined }).attach).toBe("Checking OpenOrc Cloud…");
    expect(hostedFileReasons({ ...base, scope: false }).attach).toBe("Checking OpenOrc Cloud…");
  });

  it("holds Send while a file uploads or the draft's files load, and until a failed one is retried or removed", () => {
    expect(hostedFileReasons({ ...base, files: [ready] }).send).toBeNull();
    expect(hostedFileReasons({ ...base, loading: true }).send).toBe("Wait for this draft's files to load.");
    expect(hostedFileReasons({ ...base, files: [ready, file({ kind: "uploading", sent: 4 })] }).send).toBe("Wait for the files to finish uploading.");
    expect(hostedFileReasons({ ...base, files: [file({ kind: "importing" })] }).send).toBe("Wait for the files to finish uploading.");
    const failed = file({ kind: "failed", message: "This file didn't finish uploading. Retry or remove it.", retryable: true });
    expect(hostedFileReasons({ ...base, files: [failed, file({ kind: "importing" })] }).send).toBe("Retry or remove the refused file to send.");
  });
});
