import type { OrganizationStorageRead } from "@openorc/protocol";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OrganizationStorage, type OrganizationStorageTransport } from "./OrganizationStorage";

afterEach(cleanup);
const read: OrganizationStorageRead = { storage: { usedBytes: 2576980378, allowanceBytes: 53687091200 }, error: null };
function fixture() {
  let refresh = () => {};
  const stop = vi.fn();
  const transport = {
    get: vi.fn(async () => read),
    subscribe: vi.fn((_spaceId: string, listener: () => void) => {
      refresh = listener;
      return stop;
    }),
  } satisfies OrganizationStorageTransport;
  return { transport, stop, refresh: () => refresh() };
}

it("shows the returned used and allowance bytes without a meter or seat-derived total", async () => {
  const f = fixture();
  render(<OrganizationStorage spaceId="team-a" revision="one" transport={f.transport} />);
  expect(await screen.findByText("2.4 GB of 50 GB used")).toBeTruthy();
  expect(f.transport.get).toHaveBeenCalledExactlyOnceWith("team-a");
});

it("omits an unread total and refreshes after upload or billing changes", async () => {
  const f = fixture();
  f.transport.get.mockResolvedValueOnce({ storage: null, error: "Offline" });
  const view = render(<OrganizationStorage spaceId="team-a" revision="one" transport={f.transport} />);
  await waitFor(() => expect(f.transport.get).toHaveBeenCalledTimes(1));
  expect(view.container.textContent).toBe("");
  act(f.refresh);
  await screen.findByText("2.4 GB of 50 GB used");
  f.transport.get.mockResolvedValueOnce({ storage: { usedBytes: 0, allowanceBytes: 1073741824 }, error: null });
  view.rerender(<OrganizationStorage spaceId="team-a" revision="two" transport={f.transport} />);
  await screen.findByText("0 KB of 1 GB used");
});

it("repeats a read invalidated while pending and ignores it after its scoped parent closes", async () => {
  const f = fixture();
  let resolve = (_value: OrganizationStorageRead) => {};
  f.transport.get.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const view = render(<OrganizationStorage spaceId="team-a" revision="one" transport={f.transport} />);
  act(f.refresh);
  await act(async () => resolve(read));
  expect(f.transport.get).toHaveBeenCalledTimes(2);
  view.unmount();
  expect(f.stop).toHaveBeenCalledOnce();
  act(f.refresh);
  expect(f.transport.get).toHaveBeenCalledTimes(2);
});
