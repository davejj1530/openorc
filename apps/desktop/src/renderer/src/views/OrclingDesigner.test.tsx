import { defaultOrclingLook, type Orcling, type RpcResults } from "@openorc/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

let separate = false;
const pip = {
  id: "pip",
  name: "Pip",
  claudeAccountId: "work",
  threadId: "pip-home",
  look: defaultOrclingLook,
  permission: "approve",
  settings: { agent: "claude", model: "sonnet", effort: null, fastMode: false },
} as unknown as Orcling;
const accounts: RpcResults["claude.accounts.list"] = {
  defaultId: "personal",
  accounts: ["personal", "work"].map((id, createdAt) => ({ id, name: id, kind: "managed", enabled: true, createdAt, status: "ready", email: null, organization: null, message: null })),
};

vi.mock("../lib/client", async (original) => ({
  ...(await original<object>()),
  useRpc: (method: string) => {
    const data: Record<string, unknown> = { "orclings.list": [pip], "orclings.groups.list": [], "claude.accounts.list": accounts, "app.settings.get": { claudeAccountsSeparate: separate } };
    return { data: data[method], error: null, isPending: false };
  },
  useRpcMutation: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));
vi.mock("../lib/rpc", () => ({ core: { call: async () => null, onReady: () => () => {}, onPush: () => () => {} } }));
vi.mock("../lib/use-model-catalog", () => ({ useModelCatalog: () => ({ data: [{ id: "sonnet", label: "Sonnet", agent: "claude", isDefault: true, efforts: [], defaultEffort: null }] }) }));
// The designer's drawings and its model picker have their own tests; here, the fields around them.
vi.mock("../components/ModelPicker", () => ({ ModelPicker: () => <button type="button">Model</button> }));
vi.mock("../components/OrclingPreview", () => ({ OrclingPreview: () => null }));
vi.mock("../components/OrclingAvatar", () => ({ OrclingSilhouette: () => null, OrclingStill: () => null }));
vi.mock("../components/TopBar", () => ({ TopBar: ({ children }: { children: React.ReactNode }) => <header>{children}</header> }));

import { OrclingDesigner } from "./OrclingDesigner";

afterEach(() => {
  cleanup();
  separate = false;
});

it("keeps a saved Orcling on its Claude account while accounts are kept separate, and says why; a new one still chooses", () => {
  const field = () => screen.getByRole<HTMLSelectElement>("combobox", { name: "Claude account" });
  const reason = "Accounts are kept separate, so an Orcling stays on its account.";
  render(<OrclingDesigner orclingId="pip" />);
  expect(field().value).toBe("work");
  expect(field().disabled).toBe(false);
  expect(screen.queryByText(reason)).toBeNull();
  cleanup();

  separate = true;
  render(<OrclingDesigner orclingId="pip" />);
  expect(field().value).toBe("work");
  expect(field().disabled).toBe(true);
  expect(screen.getByText(reason)).toBeTruthy();
  cleanup();

  render(<OrclingDesigner />);
  expect(field().disabled).toBe(false);
  expect(screen.queryByText(reason)).toBeNull();
});
