import { expect, it, vi } from "vitest";
import { HostedAssetLease } from "./hosted-asset-lease";

const image = { contentType: "image/webp", data: "preview" };
function fixture(read: () => Promise<typeof image | null> = async () => image) {
  const create = vi.fn(() => "blob:preview");
  const revoke = vi.fn();
  return { lease: new HostedAssetLease({ read, create, revoke }), create, revoke };
}

it("releases the preview and closes its viewer on invalidation", async () => {
  const { lease, revoke } = fixture();
  lease.start();
  await vi.waitFor(() => expect(lease.getSnapshot()).toEqual({ kind: "ready", url: "blob:preview" }));
  const close = vi.fn();
  lease.onInvalidated(close);
  lease.refresh();
  expect(revoke).toHaveBeenCalledWith("blob:preview");
  expect(close).toHaveBeenCalledOnce();
  expect(lease.getSnapshot()).toEqual({ kind: "loading" });
  lease.close();
});

it("does not publish an old response after the view closes and starts again", async () => {
  let reply = (_image: typeof image) => {};
  const first = new Promise<typeof image>((resolve) => {
    reply = resolve;
  });
  const read = vi.fn().mockReturnValueOnce(first).mockResolvedValue(null);
  const { lease, create } = fixture(read);
  lease.start();
  lease.close();
  lease.start();
  await vi.waitFor(() => expect(lease.getSnapshot()).toEqual({ kind: "empty" }));
  reply(image);
  await Promise.resolve();
  expect(create).not.toHaveBeenCalled();
  expect(lease.getSnapshot()).toEqual({ kind: "empty" });
  lease.close();
});

it("keeps the read's refusal and only retries when asked", async () => {
  const read = vi.fn().mockRejectedValueOnce(new Error("OpenOrc Cloud can't be reached.")).mockResolvedValue(image);
  const { lease } = fixture(read);
  lease.start();
  await vi.waitFor(() => expect(lease.getSnapshot()).toEqual({ kind: "failed", message: "OpenOrc Cloud can't be reached." }));
  expect(read).toHaveBeenCalledOnce();
  lease.refresh();
  await vi.waitFor(() => expect(lease.getSnapshot().kind).toBe("ready"));
  lease.failed();
  expect(lease.getSnapshot()).toEqual({ kind: "failed", message: "This image couldn't be opened. Try again." });
  lease.close();
});
