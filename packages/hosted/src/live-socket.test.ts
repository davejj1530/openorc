import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { liveSocketOf, type SocketIoSocket } from "./live-socket.js";

const socket = { active: false, on: vi.fn(), connect: vi.fn(), close: vi.fn() };
const liveSocket = liveSocketOf(() => socket as unknown as SocketIoSocket);
function emit(event: string, value?: unknown) {
  for (const [name, listener] of socket.on.mock.calls) if (name === event) listener(value);
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  socket.active = false;
});
afterEach(() => vi.useRealTimers());

it("reconnects after the server removes its rooms, but never after explicit close", async () => {
  const live = liveSocket("http://example.test", "fixture-token");
  const state = vi.fn();
  live.onState(state);
  emit("connect");
  emit("disconnect", "io server disconnect");
  await vi.advanceTimersByTimeAsync(0);
  expect(socket.connect).toHaveBeenCalledOnce();
  emit("connect");
  expect(state.mock.calls.map(([value]) => value)).toEqual(["up", "down", "up"]);
  emit("disconnect", "io server disconnect");
  live.close();
  emit("disconnect", "io client disconnect");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(socket.connect).toHaveBeenCalledOnce();
  expect(socket.close).toHaveBeenCalledOnce();
});

it("leaves network retries to the socket and cancels pending retries on refusal", async () => {
  const live = liveSocket("http://example.test", "fixture-token");
  const state = vi.fn();
  live.onState(state);
  socket.active = true;
  emit("disconnect", "transport close");
  emit("connect_error", new Error("Network unavailable"));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(socket.connect).not.toHaveBeenCalled();
  socket.active = false;
  emit("connect_error", new Error("Try again"));
  emit("connect_error", new Error("Try again"));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(socket.connect).toHaveBeenCalledOnce();
  emit("connect_error", new Error("Try again"));
  emit("connect_error", new Error("UNAUTHORIZED"));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(socket.connect).toHaveBeenCalledOnce();
  expect(state).toHaveBeenLastCalledWith("refused");
  live.close();
});
