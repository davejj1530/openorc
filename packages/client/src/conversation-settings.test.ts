// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { SavedThreadSettings } from "./conversation-settings.js";
import { testClient } from "./test-fixtures/fake-connection.js";

const { client, call, wrapper } = testClient();
const thread = { id: "thread", agent: "codex" as const, model: "gpt-6-sol", effort: "medium", fastMode: false, mode: "act" as const, permissionMode: "trusted" as const };

afterEach(() => {
  cleanup();
  client.queryClient.clear();
  call.mockReset();
});

it("saves rapid choices in order and holds send until both writes finish", async () => {
  const finish: ((value: unknown) => void)[] = [];
  call.mockImplementation((method) => {
    if (method === "threads.update") return new Promise((resolve) => finish.push(resolve));
    return Promise.resolve({});
  });
  const { result } = renderHook(() => client.useConversationSettings({ thread, activeRun: undefined }), { wrapper });
  act(() => {
    result.current.selectMode("plan");
    result.current.selectMode("act");
  });
  let sent = false;
  const saving = result.current.waitForSave().then(() => (sent = true));
  await waitFor(() => expect(finish).toHaveLength(1));
  await act(async () => finish[0]!({}));
  await waitFor(() => expect(finish).toHaveLength(2));
  expect(sent).toBe(false);
  await act(async () => {
    finish[1]!({});
    await saving;
  });
  expect(sent).toBe(true);
  expect(call.mock.calls.filter(([method]) => method === "threads.update").map(([, input]) => (input as { patch: unknown }).patch)).toEqual([{ mode: "plan" }, { mode: "act" }]);
});

const updates = () => call.mock.calls.filter(([method]) => method === "threads.update").map(([, input]) => (input as { patch: unknown }).patch);

it("blocks send after a failed save, and the next send saves it again before it goes", async () => {
  call.mockImplementation((method) => (method === "threads.update" ? Promise.reject(new Error("Save refused")) : Promise.resolve({})));
  const { result } = renderHook(() => client.useConversationSettings({ thread, activeRun: undefined }), { wrapper });
  act(() => result.current.selectMode("plan"));
  await expect(result.current.waitForSave()).rejects.toThrow("Save refused");
  await waitFor(() => expect(result.current.error?.message).toBe("Save refused"));
  call.mockResolvedValue({});
  await act(async () => {
    await result.current.waitForSave();
  });
  expect(updates().at(-1)).toEqual({ mode: "plan" });
  await waitFor(() => expect(result.current.error).toBeNull());
  expect(result.current.mode).toBe("plan");
});

it("recovers on the next selection of the same setting", async () => {
  call.mockImplementation((method) => (method === "threads.update" ? Promise.reject(new Error("Save refused")) : Promise.resolve({})));
  const { result } = renderHook(() => client.useConversationSettings({ thread, activeRun: undefined }), { wrapper });
  act(() => result.current.selectMode("plan"));
  await expect(result.current.waitForSave()).rejects.toThrow("Save refused");
  call.mockResolvedValue({});
  act(() => result.current.selectMode("act"));
  await act(async () => {
    await result.current.waitForSave();
  });
  expect(updates().at(-1)).toEqual({ mode: "act" });
  expect(result.current.mode).toBe("act");
});

it("still saves a model whose save failed when a later mode save went through", async () => {
  let refuse = true;
  call.mockImplementation((method, input) => {
    if (method !== "threads.update") return Promise.resolve({});
    return refuse && "model" in (input as { patch: object }).patch ? Promise.reject(new Error("Dropped")) : Promise.resolve({});
  });
  const { result } = renderHook(() => client.useConversationSettings({ thread, activeRun: undefined }), { wrapper });
  const model = { agent: "codex" as const, model: "gpt-6-terra", effort: "high", fastMode: false };
  act(() => {
    result.current.selectModel(model);
    result.current.selectMode("plan");
  });
  await waitFor(() => expect(updates()).toEqual([model, { mode: "plan" }]));
  refuse = false;
  await act(async () => {
    await result.current.waitForSave();
  });
  expect(updates()).toEqual([model, { mode: "plan" }, model]);
});

it("saves what the composer shows after the thread's saved permission changes elsewhere, never the failed pick", async () => {
  call.mockImplementation((method) => (method === "threads.update" ? Promise.reject(new Error("Dropped")) : Promise.resolve({})));
  const { result, rerender } = renderHook(({ saved }) => client.useConversationSettings({ thread: saved, activeRun: undefined }), { wrapper, initialProps: { saved: thread as SavedThreadSettings } });
  act(() => result.current.selectPermission("autonomous"));
  await expect(result.current.waitForSave()).rejects.toThrow("Dropped");
  const failed = updates().length;
  rerender({ saved: { ...thread, permissionMode: "review" } });
  await waitFor(() => expect(result.current.permission).toBe("review"));
  call.mockResolvedValue({});
  await act(async () => {
    await result.current.waitForSave();
  });
  expect(updates().slice(failed)).toEqual([{ permissionMode: "review" }]);
});

it("saves the model the composer shows after the thread's saved model changes elsewhere, never the failed pick", async () => {
  call.mockImplementation((method) => (method === "threads.update" ? Promise.reject(new Error("Dropped")) : Promise.resolve({})));
  const { result, rerender } = renderHook(({ saved }) => client.useConversationSettings({ thread: saved, activeRun: undefined }), { wrapper, initialProps: { saved: thread as SavedThreadSettings } });
  act(() => result.current.selectModel({ agent: "codex", model: "gpt-6-terra", effort: "high", fastMode: false }));
  await expect(result.current.waitForSave()).rejects.toThrow("Dropped");
  const failed = updates().length;
  rerender({ saved: { ...thread, model: "gpt-6-luna" } });
  await waitFor(() => expect(result.current.choice?.model).toBe("gpt-6-luna"));
  call.mockResolvedValue({});
  await act(async () => {
    await result.current.waitForSave();
  });
  expect(updates().slice(failed)).toEqual([{ agent: "codex", model: "gpt-6-luna", effort: "medium", fastMode: false }]);
});
