import type { ThreadSummary } from "@openorc/protocol";
import { expect, it, vi } from "vitest";
import type { LinkState } from "../connection/manager";
import { sendBlocked } from "./send-blocked";

vi.mock("../client", () => ({ shownMacId: () => "mac-1" }));

const connected: LinkState = { kind: "connected", mac: { id: "mac-1", name: "Studio" }, route: { kind: "lan", host: "studio.local", port: 1 }, serial: 1 };
const ready = { permissionReady: true, choice: { agent: "claude", model: "claude-opus-5-5" } };
const loaded = { isLoading: false, error: null };
const thread = (moving: ThreadSummary["moving"]) => ({ id: "t1", projectId: "p1", activity: "idle", moving }) as unknown as ThreadSummary;

it("holds a thread under way between the Mac and OpenOrc Cloud in the shared words, and frees it once the move stops", () => {
  expect(sendBlocked(connected, ready, loaded, thread({ to: "cloud", failed: null }), false)).toBe("Moving to OpenOrc Cloud");
  expect(sendBlocked(connected, ready, loaded, thread({ to: "mac", failed: null }), false)).toBe("Moving to Studio");
  expect(sendBlocked(connected, ready, loaded, thread({ to: "cloud", failed: "The folder has changes that aren't committed." }), false)).toBeNull();
  expect(sendBlocked(connected, ready, loaded, thread(null), false)).toBeNull();
});
