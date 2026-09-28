import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcResults } from "@openorc/protocol";

const refetchStatus = vi.fn();
const configureWorkspace = vi.fn();
const call = vi.fn();
let statusData: RpcResults["slack.status"];

vi.mock("../lib/query", () => ({
  useRpc: (method: string) => (method === "slack.status" ? { data: statusData, isError: false, refetch: refetchStatus } : { data: { rootPath: "/workspace" }, isError: false }),
  useRpcMutation: () => ({ isPending: false, error: null, mutateAsync: configureWorkspace }),
}));
vi.mock("../lib/rpc", () => ({ core: { call: (...args: unknown[]) => call(...args) } }));
vi.mock("./settings-slack-direct", () => ({ DirectSlackSettings: ({ active }: { active: boolean }) => <div data-testid="direct" data-active={active} /> }));

import { SlackSettings } from "./settings-slack";

afterEach(cleanup);
beforeEach(() => {
  call.mockReset();
  call.mockResolvedValue(null);
  configureWorkspace.mockReset();
  refetchStatus.mockReset();
  statusData = {
    mode: "direct",
    direct: { configured: false, enabled: false, connected: false, busy: false, error: null, config: null, workspace: null, ownerName: null, botId: null },
    host: { enabled: false, connected: false, configured: false, port: 47831, channelId: "", workspace: null, error: null },
    client: { enabled: false, busy: false, connected: false, configured: false, error: null, userId: null, config: null },
    devices: [],
  };
  refetchStatus.mockImplementation(async () => ({ data: statusData }));
});

function openRelay() {
  render(<SlackSettings active />);
  fireEvent.change(screen.getByRole("combobox", { name: /^Connect Slack/ }), { target: { value: "relay" } });
}

describe("Slack settings relay", () => {
  it("keeps direct and relay separate and locks the connection type during live work", () => {
    const view = render(<SlackSettings active />);
    expect(screen.getByTestId("direct").getAttribute("data-active")).toBe("true");
    fireEvent.change(screen.getByRole("combobox", { name: /^Connect Slack/ }), { target: { value: "relay" } });
    expect(screen.getByTestId("direct").getAttribute("data-active")).toBe("false");
    expect(screen.getByText("Desktop connection")).toBeTruthy();
    statusData = { ...statusData, client: { ...statusData.client, busy: true } };
    view.rerender(<SlackSettings active />);
    expect(screen.getByRole("combobox", { name: /^Connect Slack/ })).toHaveProperty("disabled", true);
  });

  it("retains a device key after save failure, then saves before connecting on retry", async () => {
    openRelay();
    fireEvent.change(screen.getByLabelText(/^Device key/), { target: { value: "oqd_test" } });
    call.mockRejectedValueOnce(new Error("Relay unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Connect this computer" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Relay unavailable"));
    expect(screen.getByLabelText(/^Device key/)).toHaveProperty("value", "oqd_test");
    expect(call).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Connect this computer" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("slack.client.connect", {}));
    expect(call.mock.calls[1]).toEqual(["slack.client.save", expect.objectContaining({ deviceKey: "oqd_test" })]);
    expect(screen.getByLabelText(/^Device key/)).toHaveProperty("value", "");
    expect(refetchStatus).toHaveBeenCalledTimes(2);
  });

  it("retries a pending client and removes only the selected registered device", async () => {
    statusData = {
      ...statusData,
      mode: "relay",
      client: { ...statusData.client, configured: true, busy: true, enabled: true, error: "Delivery pending" },
      devices: [
        { id: "device-1", label: "Alice", userId: "U1", online: false },
        { id: "device-2", label: "Bob", userId: "U2", online: true },
      ],
    };
    render(<SlackSettings active />);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect to send result" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("slack.client.connect", {}));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect desktop" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("slack.client.disconnect", {}));
    fireEvent.click(screen.getByText("Host the Slack connection"));
    const remove = screen.getAllByRole("button", { name: "Remove" });
    fireEvent.click(remove[0]!);
    await waitFor(() => expect(call).toHaveBeenCalledWith("slack.device.remove", { id: "device-1" }));
    expect(call).not.toHaveBeenCalledWith("slack.device.remove", { id: "device-2" });
  });

  it("retains relay tokens on save failure and clears them after a saved connection", async () => {
    openRelay();
    fireEvent.click(screen.getByText("Host the Slack connection"));
    fireEvent.change(screen.getByLabelText(/^Bot token/), { target: { value: "xoxb-test" } });
    fireEvent.change(screen.getByLabelText(/^App token/), { target: { value: "xapp-test" } });
    call.mockRejectedValueOnce(new Error("Invalid relay token"));
    fireEvent.click(screen.getByRole("button", { name: "Save and connect relay" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Invalid relay token"));
    expect(screen.getByLabelText(/^Bot token/)).toHaveProperty("value", "xoxb-test");
    fireEvent.click(screen.getByRole("button", { name: "Save and connect relay" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("slack.host.connect", {}));
    expect(call.mock.calls[1]).toEqual(["slack.host.save", expect.objectContaining({ botToken: "xoxb-test", appToken: "xapp-test", port: 47831 })]);
    expect(screen.getByLabelText(/^Bot token/)).toHaveProperty("value", "");
    expect(screen.getByLabelText(/^App token/)).toHaveProperty("value", "");
  });
});
