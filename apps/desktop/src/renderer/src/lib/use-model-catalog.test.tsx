import { renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ModelCatalog } from "@openorc/protocol";
import { useModelCatalog } from "./use-model-catalog";

const mac: ModelCatalog = { models: [{ id: "claude-opus-5-5", label: "Opus 5.5", agent: "claude", isDefault: true, efforts: [], defaultEffort: null }], providers: [] };
const cloud: ModelCatalog = { models: [{ id: "gpt-5.5", label: "GPT-5.5", agent: "codex", isDefault: true, efforts: [], defaultEffort: null }], providers: [] };
let cloudAnswer: ModelCatalog | null | undefined;
const asked: { method: string; enabled: boolean }[] = [];

vi.mock("./claude-account", () => ({ useClaudeAccountId: () => undefined }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ setQueryData: vi.fn(), invalidateQueries: vi.fn() }) }));
vi.mock("./client", () => ({
  useRpc: (method: string, _params: unknown, options?: { enabled?: boolean }) => {
    const enabled = options?.enabled !== false;
    asked.push({ method, enabled });
    const data = method === "cloudModels.catalog" ? cloudAnswer : mac;
    return { data: enabled ? data : undefined, isFetching: false, isError: false, refetch: vi.fn() };
  },
  useRpcMutation: () => ({ mutateAsync: vi.fn(), isPending: false, isError: false }),
}));

beforeEach(() => {
  asked.length = 0;
  cloudAnswer = cloud;
});

it("lists this Mac's models where the conversation runs here, and never asks the cloud", () => {
  const { result } = renderHook(() => useModelCatalog());
  expect(result.current.data).toEqual(mac.models);
  expect(asked.filter((read) => read.enabled).map((read) => read.method)).toEqual(["agents.modelCatalog"]);
});

it("lists the models OpenOrc Cloud runs for a cloud place, without reading this Mac's", () => {
  const { result } = renderHook(() => useModelCatalog(true));
  expect(result.current.data).toEqual(cloud.models);
  expect(asked.filter((read) => read.enabled).map((read) => read.method)).toEqual(["cloudModels.catalog"]);
});

it("falls back to this Mac's models where the server keeps no catalog", () => {
  cloudAnswer = null;
  const { result } = renderHook(() => useModelCatalog(true));
  expect(result.current.data).toEqual(mac.models);
});
