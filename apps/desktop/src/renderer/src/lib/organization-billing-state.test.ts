import type { OrganizationBillingPage, OrganizationBillingStatus } from "@openorc/protocol";
import { expect, it, vi } from "vitest";
import { OrganizationBillingView } from "./organization-billing-state";

const empty: OrganizationBillingStatus = {
  billing: { organization: { id: "team-a", name: "Example team", logo: null }, revision: "1", asOf: 1000, subscription: null, seats: [], available: 0 },
  payment: null,
  error: null,
};
const target: OrganizationBillingPage = { page: "checkout", plan: "monthly", seats: 3 };
const waiting: OrganizationBillingStatus = { ...empty, payment: { id: "request-a", target, state: "waiting", since: 1000, watching: true, error: null } };
const complete: OrganizationBillingStatus = { ...waiting, payment: { ...waiting.payment!, state: "complete", watching: false } };
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  let allowed = true;
  const deps = {
    current: () => allowed,
    get: vi.fn(async () => empty),
    open: vi.fn(async (_target: OrganizationBillingPage) => waiting),
    leave: vi.fn(async () => ({ ...waiting, payment: waiting.payment && { ...waiting.payment, watching: false } })),
  };
  const view = new OrganizationBillingView(deps);
  return {
    view,
    deps,
    revoke: () => {
      allowed = false;
      view.revoke();
    },
  };
}

it("keeps the previous confirmed inventory after a read failure", async () => {
  const f = fixture();
  await f.view.refresh();
  f.deps.get.mockRejectedValueOnce(new Error("Offline"));
  await f.view.refresh();
  expect(f.view.getSnapshot()).toMatchObject({ status: empty, error: "Offline", loading: false });
});
it("clears the inventory as soon as core returns an authority refusal, before a spaces update", async () => {
  const f = fixture();
  await f.view.refresh();
  const refused = { billing: null, payment: null, error: "Only an admin can do that." };
  f.deps.get.mockResolvedValueOnce(refused);
  await f.view.refresh();
  expect(f.view.getSnapshot()).toMatchObject({ status: refused, error: refused.error, loading: false });
});
it("coalesces duplicate presses and never lets a preceding read erase the waiting state", async () => {
  const f = fixture(),
    late = deferred<OrganizationBillingStatus>();
  f.deps.get.mockReturnValueOnce(late.promise);
  const reading = f.view.refresh();
  await Promise.all([f.view.open(target), f.view.open(target)]);
  late.resolve(empty);
  await reading;
  expect(f.deps.open).toHaveBeenCalledExactlyOnceWith(target);
  expect(f.view.getSnapshot().status?.payment?.state).toBe("waiting");
});
it("learns the core's durable pending request with a read after a lost RPC response", async () => {
  const f = fixture();
  f.deps.open.mockRejectedValueOnce(new Error("Response lost"));
  f.deps.get.mockResolvedValueOnce({ ...waiting, payment: waiting.payment && { ...waiting.payment, state: "pending", error: "Outcome not known yet" } });
  await f.view.open(target);
  expect(f.deps.open).toHaveBeenCalledTimes(1);
  expect(f.view.getSnapshot().status?.payment?.state).toBe("pending");
  expect(f.deps.get).toHaveBeenCalledTimes(1);
});
it("keeps a completed purchase complete after a failed read and retries only that read", async () => {
  const f = fixture();
  f.deps.open.mockResolvedValueOnce(complete);
  await f.view.open(target);
  f.deps.get.mockRejectedValueOnce(new Error("Offline"));
  await f.view.refresh();
  expect(f.view.getSnapshot()).toMatchObject({ status: { payment: { state: "complete" } }, error: "Offline" });
  await f.view.refresh();
  expect(f.deps.open).toHaveBeenCalledTimes(1);
});
it("discards prices and inventory when admin authority ends, including late reads", async () => {
  const f = fixture(),
    late = deferred<OrganizationBillingStatus>();
  await f.view.refresh();
  f.deps.get.mockReturnValueOnce(late.promise);
  const reading = f.view.refresh();
  f.revoke();
  late.resolve(waiting);
  await reading;
  expect(f.view.getSnapshot().status).toBeNull();
  await f.view.open(target);
  expect(f.deps.open).not.toHaveBeenCalled();
});
it("stops the temporary watch on leaving without fabricating cancellation", async () => {
  const f = fixture();
  await f.view.open(target);
  await f.view.leave();
  expect(f.view.getSnapshot().status?.payment).toMatchObject({ state: "waiting", watching: false });
  expect(f.deps.open).toHaveBeenCalledTimes(1);
});

it("keeps an unknown core result closed to a new purchase until its read succeeds", async () => {
  const f = fixture();
  f.deps.open.mockRejectedValueOnce(new Error("Response lost"));
  f.deps.get.mockRejectedValueOnce(new Error("Offline"));
  await f.view.open(target);
  expect(f.view.getSnapshot()).toMatchObject({ uncertain: true, error: "Offline" });
  await f.view.open({ page: "checkout", plan: "yearly", seats: 8 });
  expect(f.deps.open).toHaveBeenCalledTimes(1);
  await f.view.refresh();
  expect(f.view.getSnapshot()).toMatchObject({ uncertain: false });
});

it("retains a payment refusal when a successful read finds no purchase to reconcile", async () => {
  const f = fixture();
  f.deps.open.mockRejectedValueOnce(new Error("This device can't open the payment page."));
  await f.view.open(target);
  expect(f.view.getSnapshot()).toMatchObject({ uncertain: false, error: "This device can't open the payment page." });
});
