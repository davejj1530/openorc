import type { SeatOperation } from "@openorc/protocol";
import { expect, it, vi } from "vitest";
import { Refused } from "./session.js";
import { OrganizationSeatOperations, type SeatAssignmentRequest } from "./organization-seat-operations.js";

const request: SeatAssignmentRequest = { seatId: "seat-a", body: { id: "ad027eda-2a21-467d-a41c-a7717745b044", previewToken: "preview-a" } };
const operation = (state: SeatOperation["state"]): SeatOperation => ({ id: request.body.id, kind: "assignment", state, message: null });
function journal() {
  let value: string | null = null;
  return {
    load: () => value,
    save: (next: string) => {
      value = next;
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(storage = journal()) {
  let current = true;
  const deps = {
    scope: { origin: "https://example.com", userId: "person-a", spaceId: "team-a" },
    storage,
    current: () => current,
    submit: vi.fn(async (_request: SeatAssignmentRequest) => operation("pending")),
    read: vi.fn(async (_id: string) => operation("pending")),
    refresh: vi.fn(async () => {}),
    changed: vi.fn(),
  };
  return {
    deps,
    runner: new OrganizationSeatOperations(deps),
    revoke: () => {
      current = false;
    },
  };
}

it("stores the exact mutation before sending and coalesces duplicate presses", async () => {
  const f = fixture(),
    gate = deferred<SeatOperation>();
  f.deps.submit.mockImplementation(async (value) => {
    expect(f.deps.storage.load()).toContain(JSON.stringify(value));
    return gate.promise;
  });
  const one = f.runner.send(request),
    two = f.runner.send(structuredClone(request));
  await vi.waitFor(() => expect(f.deps.submit).toHaveBeenCalledTimes(1));
  gate.resolve(operation("pending"));
  expect(await one).toEqual(await two);
  expect(f.runner.list()[0]).toMatchObject({ request, operation: operation("pending") });
});

it("keeps a lost response pending across restart and replays only its saved request", async () => {
  const storage = journal(),
    first = fixture(storage);
  first.deps.submit.mockRejectedValueOnce(new TypeError("Response lost"));
  expect(await first.runner.send(request)).toMatchObject({ request, operation: null, error: "Response lost" });
  first.runner.close();
  const second = fixture(storage);
  second.deps.read.mockRejectedValueOnce(new Refused("No such operation", 404));
  expect(await second.runner.retry(request.body.id)).toMatchObject({ request, operation: operation("pending"), error: null });
  expect(second.deps.submit).toHaveBeenCalledExactlyOnceWith(request);
});

it("does not repeat a mutation automatically when an unknown operation cannot be read", async () => {
  const f = fixture();
  f.deps.submit.mockRejectedValueOnce(new TypeError("Response lost"));
  await f.runner.send(request);
  f.deps.read.mockRejectedValueOnce(new Refused("No such operation", 404));
  await f.runner.reconcile();
  expect(f.deps.submit).toHaveBeenCalledTimes(1);
  expect(f.runner.list()[0]).toMatchObject({ operation: null });
});

it("reads one saved operation without replaying an unknown write", async () => {
  const f = fixture();
  expect(await f.runner.read(request.body.id)).toBeNull();
  expect(f.deps.read).not.toHaveBeenCalled();
  f.deps.submit.mockRejectedValueOnce(new TypeError("Response lost"));
  await f.runner.send(request);
  f.deps.read.mockRejectedValueOnce(new Refused("No such operation", 404));
  expect(await f.runner.read(request.body.id)).toMatchObject({ request, operation: null });
  expect(f.deps.submit).toHaveBeenCalledTimes(1);
  f.deps.read.mockResolvedValueOnce(operation("complete"));
  expect(await f.runner.read(request.body.id)).toMatchObject({ operation: operation("complete") });
  expect(f.deps.submit).toHaveBeenCalledTimes(1);
});

it("reconciles a lost response with its already-completed operation without another mutation", async () => {
  const f = fixture();
  f.deps.submit.mockRejectedValueOnce(new TypeError("Response lost"));
  await f.runner.send(request);
  f.deps.read.mockResolvedValueOnce(operation("complete"));
  expect(await f.runner.retry(request.body.id)).toMatchObject({ operation: operation("complete") });
  expect(f.deps.submit).toHaveBeenCalledTimes(1);
  expect(f.deps.refresh).toHaveBeenCalledTimes(1);
});

it("never repeats a known pending operation even when its later read returns 404", async () => {
  const f = fixture();
  await f.runner.send(request);
  f.deps.read.mockRejectedValueOnce(new Refused("No such operation", 404));
  expect(await f.runner.retry(request.body.id)).toMatchObject({ operation: operation("pending"), error: "No such operation" });
  expect(f.deps.submit).toHaveBeenCalledTimes(1);
});

it("stores completion before the following read and lets retry only refresh that read", async () => {
  const f = fixture();
  f.deps.submit.mockResolvedValueOnce(operation("complete"));
  f.deps.refresh.mockImplementationOnce(async () => {
    expect(f.deps.storage.load()).toContain('"state":"complete"');
    throw new Error("Read failed");
  });
  expect(await f.runner.send(request)).toMatchObject({ operation: operation("complete"), error: "Read failed" });
  expect(await f.runner.retry(request.body.id)).toMatchObject({ operation: operation("complete"), error: null });
  expect(f.deps.submit).toHaveBeenCalledTimes(1);
  expect(f.deps.read).not.toHaveBeenCalled();
  expect(f.deps.refresh).toHaveBeenCalledTimes(2);
});

it("keeps failed or stale previews terminal until a different request is explicitly submitted", async () => {
  const f = fixture();
  f.deps.submit.mockRejectedValueOnce(new Refused("That seat has changed. Review the change again.", 409));
  const failed = await f.runner.send(request);
  expect(failed.operation).toMatchObject({ state: "failed", message: "That seat has changed. Review the change again." });
  expect(await f.runner.retry(request.body.id)).toEqual(failed);
  expect(f.deps.submit).toHaveBeenCalledTimes(1);
});

it("refuses a changed body under an existing id and a second pending operation on the seat", async () => {
  const f = fixture();
  await f.runner.send(request);
  await expect(f.runner.send({ ...request, body: { ...request.body, previewToken: "changed" } })).rejects.toThrow("different details");
  await expect(f.runner.send({ ...request, body: { ...request.body, id: "d546c981-d6eb-43ad-a17c-1bca0c0c0411" } })).rejects.toThrow("Moving the seat.");
  expect(f.deps.submit).toHaveBeenCalledTimes(1);
});

it("closes privileged work on authority loss and discards a late result", async () => {
  const f = fixture(),
    gate = deferred<SeatOperation>();
  f.deps.submit.mockReturnValueOnce(gate.promise);
  const writing = f.runner.send(request);
  const refused = expect(writing).rejects.toThrow("access changed");
  f.revoke();
  gate.resolve(operation("complete"));
  await refused;
  expect(f.runner.list()).toEqual([]);
  await expect(f.runner.retry(request.body.id)).rejects.toThrow("access changed");
  expect(f.deps.refresh).not.toHaveBeenCalled();
});

it("keeps operation journals scoped to account, origin and organization", async () => {
  const f = fixture();
  await f.runner.send(request);
  for (const scope of [
    { ...f.deps.scope, userId: "person-b" },
    { ...f.deps.scope, spaceId: "team-b" },
    { ...f.deps.scope, origin: "https://other.example.com" },
  ]) {
    const other = new OrganizationSeatOperations({ ...f.deps, scope });
    expect(other.list()).toEqual([]);
    await expect(other.retry(request.body.id)).rejects.toThrow("could not be found");
  }
});

it("refuses to send when persistence fails or its existing journal is unreadable", async () => {
  const f = fixture({
    load: () => null,
    save: () => {
      throw new Error("Disk unavailable");
    },
  });
  await expect(f.runner.send(request)).rejects.toThrow("Disk unavailable");
  expect(f.deps.submit).not.toHaveBeenCalled();
  const corrupt = fixture({ load: () => "broken", save: vi.fn() });
  await expect(corrupt.runner.send(request)).rejects.toThrow("Saved seat changes could not be read");
  expect(corrupt.deps.submit).not.toHaveBeenCalled();
});

it("keeps a closed operation durable and never applies a different operation's reply", async () => {
  const f = fixture();
  f.deps.submit.mockResolvedValueOnce({ ...operation("complete"), id: "another-operation" });
  expect(await f.runner.send(request)).toMatchObject({ operation: null });
  f.runner.close();
  expect(f.runner.list()).toEqual([]);
  expect(f.deps.storage.load()).toContain(request.body.id);
});

it("does not let a synchronous refresh notification replace the initial mutation", async () => {
  const f = fixture();
  f.deps.changed.mockImplementation(() => {
    void f.runner.reconcile();
  });
  await f.runner.send(request);
  expect(f.deps.submit).toHaveBeenCalledExactlyOnceWith(request);
});

it("cannot overwrite recorded completion when saving a follow-up read error fails", async () => {
  const stored = journal();
  let saves = 0;
  const f = fixture({
    load: stored.load,
    save: (value) => {
      if (++saves === 3) throw new Error("Disk unavailable");
      stored.save(value);
    },
  });
  f.deps.submit.mockResolvedValueOnce(operation("complete"));
  f.deps.refresh.mockRejectedValueOnce(new Error("Read failed"));
  await f.runner.send(request).catch(() => undefined);
  expect(f.runner.list()[0]?.operation?.state).toBe("complete");
  await f.runner.retry(request.body.id);
  expect(f.deps.submit).toHaveBeenCalledTimes(1);
});

it("rechecks authority before sending after notifying subscribers", async () => {
  const f = fixture();
  f.deps.changed.mockImplementation(f.revoke);
  await expect(f.runner.send(request)).rejects.toThrow("access changed");
  expect(f.deps.submit).not.toHaveBeenCalled();
});
