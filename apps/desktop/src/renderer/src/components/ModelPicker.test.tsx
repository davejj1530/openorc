import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelOption, SystemInfo } from "@openorc/protocol";
import { ComposerModelPicker, defaultChoice, ModelPicker, type ModelChoice } from "./ModelPicker";

const mocks = vi.hoisted(() => ({ call: vi.fn(), navigate: vi.fn() }));
vi.mock("../lib/rpc", () => ({ core: { call: mocks.call, onInvalidate: () => {}, onReady: () => {} } }));
vi.mock("../lib/router", () => ({ useRouter: { getState: () => ({ navigate: mocks.navigate }) } }));
vi.mock("./EffortGalaxy", () => ({ EffortGalaxy: () => <span data-testid="effort-galaxy" /> }));
vi.mock("./FastModeRocket", () => ({ FastModeRocket: () => <span data-testid="fast-mode-rocket" /> }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const info: SystemInfo = {
  dataDir: "/data",
  harnesses: [
    { id: "codex", state: "ready", path: "/bin/codex", version: "1", revision: 0 },
    { id: "claude", state: "sign_in", path: "/bin/claude", version: "1", revision: 0 },
    { id: "opencode", state: "ready", path: "/bin/opencode", version: "1", revision: 0 },
  ],
  gh: { installed: false, path: null },
};
const models: ModelOption[] = [
  { id: "gpt", label: "GPT", agent: "codex", isDefault: true, efforts: ["low", "high"], defaultEffort: "low", provider: { id: "codex", label: "ChatGPT account" } },
  { id: "sonnet", label: "Sonnet", agent: "claude", isDefault: true, efforts: [], defaultEffort: null, provider: { id: "claude", label: "Claude account" } },
  { id: "opencode/big", label: "Big", agent: "opencode", isDefault: true, efforts: [], defaultEffort: null, provider: { id: "opencode", label: "opencode" } },
  { id: "openrouter/acme/fast", label: "Acme Fast", agent: "opencode", isDefault: false, efforts: [], defaultEffort: null, provider: { id: "openrouter", label: "openrouter" } },
];

const rows = () =>
  screen
    .queryAllByRole("button")
    .filter((row) => row.hasAttribute("data-picker-row"))
    .map((row) => row.textContent);

describe("ModelPicker", () => {
  it.each([false, true])("selects OpenCode variants and resets to Default in both picker layouts (composer=%s)", async (composer) => {
    const model: ModelOption = { ...models[2]!, efforts: ["low", "high", "deep-analysis", "default"], defaultEffort: "default" };
    mocks.call.mockImplementation(async (method) => (method === "agents.modelCatalog" ? { models: [model], providers: [] } : info));
    const changed = vi.fn();
    function Fixture() {
      const [choice, setChoice] = useState<ModelChoice>({ agent: "opencode", model: model.id, effort: null });
      const onChange = (next: ModelChoice) => {
        changed(next);
        setChoice(next);
      };
      return composer ? <ComposerModelPicker value={choice} onChange={onChange} modelSelector={<span>Model selector</span>} /> : <ModelPicker value={choice} onChange={onChange} />;
    }
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Fixture />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: composer ? "Model and effort" : "Big" }));
    const selector = await screen.findByRole("combobox", { name: "Reasoning effort" });
    expect((selector as HTMLSelectElement).selectedOptions[0]?.textContent).toBe("Default");
    expect(screen.queryByRole("slider", { name: "Reasoning effort" })).toBeNull();
    expect(screen.queryByTestId("effort-galaxy")).toBeNull();
    fireEvent.change(selector, { target: { value: "2" } });
    expect(changed).toHaveBeenLastCalledWith({ agent: "opencode", model: model.id, effort: "deep-analysis" });
    fireEvent.click(screen.getByRole("button", { name: "Reset effort to model default" }));
    expect(changed).toHaveBeenLastCalledWith({ agent: "opencode", model: model.id, effort: "default" });
  });

  it("describes absent effort options without claiming the model has a fixed level", async () => {
    mocks.call.mockImplementation(async (method) => (method === "agents.modelCatalog" ? { models, providers: [] } : info));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ModelPicker value={{ agent: "opencode", model: "opencode/big", effort: null }} onChange={vi.fn()} />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Big" }));
    expect(await screen.findByText("This connection does not advertise adjustable effort options for this model.")).toBeTruthy();
    expect(screen.queryByText(/fixed effort/)).toBeNull();
  });

  it("offers ultracode as the last Claude stop and explains it beneath the slider", async () => {
    const opus: ModelOption = { id: "claude-opus-5", agent: "claude", label: "Opus", efforts: ["low", "medium", "high", "xhigh", "max", "ultracode"], defaultEffort: "medium", isDefault: true };
    mocks.call.mockImplementation(async (method) => (method === "agents.modelCatalog" ? { models: [opus], providers: [] } : info));
    function Fixture() {
      const [choice, setChoice] = useState<ModelChoice>({ agent: "claude", model: opus.id, effort: "max" });
      return <ComposerModelPicker value={choice} onChange={setChoice} />;
    }
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Fixture />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Model and effort" }));
    const slider = await screen.findByRole("slider", { name: "Reasoning effort" });
    expect(slider.getAttribute("max")).toBe("5");
    expect(screen.queryByText("Extra high + workflows")).toBeNull();
    fireEvent.change(slider, { target: { value: "5" } });
    expect(slider.getAttribute("aria-valuetext")).toBe("Ultracode");
    expect(screen.getByText("Extra high + workflows")).toBeTruthy();
    expect(slider.closest(".composer-effort-slider")?.getAttribute("data-ultracode")).toBe("true");
  });
  it("keeps model selection and effort in one composer panel", async () => {
    const catalog = [models[0]!, { ...models[0]!, id: "gpt-plus", label: "GPT Plus", defaultEffort: "high", isDefault: false }];
    mocks.call.mockImplementation(async (method) => (method === "agents.modelCatalog" ? { models: catalog, providers: [] } : info));
    function Fixture() {
      const [choice, setChoice] = useState<ModelChoice>({ agent: "codex", model: "gpt", effort: "low" });
      return <ComposerModelPicker value={choice} onChange={setChoice} />;
    }
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Fixture />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Model and effort" }));
    expect(screen.getByRole("dialog", { name: "Model and effort" })).toBeTruthy();
    expect(document.querySelectorAll(".menu-popup")).toHaveLength(0);
    expect(screen.getByRole("group", { name: "Model providers" }).contains(screen.getByRole("button", { name: "Fast mode" }))).toBe(true);
    const search = screen.getByRole("textbox", { name: "Search models" });
    expect(document.activeElement).not.toBe(search);
    await waitFor(() => expect((screen.getByRole("button", { name: /GPT default/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /GPT default/ }));
    fireEvent.click(screen.getByRole("button", { name: "GPT Plus" }));
    expect(screen.getByRole("dialog", { name: "Model and effort" })).toBeTruthy();
    expect(screen.getByRole("slider", { name: "Reasoning effort" }).getAttribute("aria-valuetext")).toBe("High");
    expect(screen.getByRole("button", { name: "GPT Plus" }).getAttribute("aria-pressed")).toBe("true");
  });
  it("keeps the rocket for Fast and the galaxy at maximum effort", async () => {
    const astra: ModelOption = {
      id: "gpt-6-astra",
      agent: "codex",
      label: "Astra",
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultEffort: "medium",
      isDefault: true,
      fastMode: { supported: true },
    };
    mocks.call.mockImplementation(async (method) => (method === "agents.modelCatalog" ? { models: [astra], providers: [] } : info));
    function Fixture() {
      const [choice, setChoice] = useState<ModelChoice>({ agent: "codex", model: astra.id, effort: "medium" });
      return <ComposerModelPicker value={choice} onChange={setChoice} />;
    }
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Fixture />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Model and effort" }));
    const fast = await screen.findByRole("button", { name: "Fast mode" });
    await waitFor(() => expect((fast as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(fast);
    expect(screen.getByTestId("fast-mode-rocket")).toBeTruthy();
    expect(document.querySelector(".composer-effort-thumb")).toBeNull();
    const slider = screen.getByRole("slider", { name: "Reasoning effort" });
    fireEvent.change(slider, { target: { value: "5" } });
    expect(slider.getAttribute("aria-valuetext")).toBe("Ultra");
    expect(screen.getByTestId("effort-galaxy")).toBeTruthy();
    expect(slider.closest(".composer-effort-slider")?.getAttribute("data-max")).toBe("true");
  });
  it("keeps saved teams and models in the same panel", async () => {
    const selectTeam = vi.fn();
    mocks.call.mockImplementation(async (method) => (method === "agents.modelCatalog" ? { models, providers: [] } : info));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ComposerModelPicker
          value={{ agent: "codex", model: "gpt", effort: "low" }}
          onChange={vi.fn()}
          team={{ name: "Review team", revision: 2, leadName: "Lead" }}
          teams={{
            options: [{ teamId: "team-1", revisionId: "revision-2", name: "Review team", revision: 2, memberCount: 3 }],
            selectedRevisionId: "revision-2",
            selectedLabel: "Review team",
            onSelect: selectTeam,
          }}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Team and lead effort" }));
    expect(screen.getByRole("button", { name: "Project teams" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /Review team 3 agents/ }));
    expect(selectTeam).toHaveBeenCalledWith("revision-2");
    expect(screen.getByRole("dialog", { name: "Model and effort" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(await screen.findByRole("button", { name: /GPT default/ })).toBeTruthy();
    expect(document.querySelectorAll(".menu-popup")).toHaveLength(0);
  });
  it("uses one provider panel, scopes search to the selected provider, and closes after selection", async () => {
    const onChange = vi.fn();
    mocks.call.mockImplementation(async (method: string) => {
      if (method === "agents.modelCatalog" || method === "agents.models.refresh") return { models, providers: [] };
      if (method === "system.info") return info;
      throw new Error(method);
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ModelPicker value={{ agent: "codex", model: "gpt", effort: "low" }} onChange={onChange} />
      </QueryClientProvider>,
    );
    const trigger = await screen.findByRole("button", { name: /GPT/ });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Model and effort" })).toBeTruthy();
    expect(document.querySelectorAll(".menu-popup")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Codex" }).getAttribute("aria-pressed")).toBe("true");
    expect(rows()).toEqual(["GPTdefault"]);

    fireEvent.click(await screen.findByRole("button", { name: "Claude Code · Sign in" }));
    expect((screen.getByRole("button", { name: /Sonnet/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "OpenCode" }));
    expect(rows()).toEqual(["Bigdefault", "Acme Fast"]);
    const search = screen.getByLabelText("Search models");
    fireEvent.change(search, { target: { value: "nothing here" } });
    expect(await screen.findByText("No models match.")).toBeTruthy();
    fireEvent.change(search, { target: { value: "big" } });
    expect(rows()).toEqual(["Bigopencodedefault"]);
    fireEvent.change(search, { target: { value: "acme" } });
    expect(rows()).toEqual(["Acme Fastopenrouter"]);
    fireEvent.click(screen.getByRole("button", { name: /Acme Fast/ }));
    expect(onChange).toHaveBeenCalledWith({ agent: "opencode", model: "openrouter/acme/fast", effort: null, fastMode: false });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("moves keyboard focus over unavailable rows and selects the focused model", async () => {
    const onChange = vi.fn();
    const unavailable: ModelOption = { ...models[0]!, id: "gpt-unavailable", label: "GPT Unavailable", isDefault: false, unavailable: "Unavailable" };
    const plus: ModelOption = { ...models[0]!, id: "gpt-plus", label: "GPT Plus", isDefault: false, defaultEffort: "high" };
    mocks.call.mockImplementation(async (method) => (method === "system.info" ? info : { models: [models[0], unavailable, plus], providers: [] }));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ModelPicker value={{ agent: "codex", model: "gpt", effort: "low" }} onChange={onChange} />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "GPT Low" }));
    const search = screen.getByRole<HTMLInputElement>("textbox", { name: "Search models" });
    const first = await screen.findByRole<HTMLButtonElement>("button", { name: "GPT default" });
    const last = screen.getByRole<HTMLButtonElement>("button", { name: "GPT Plus" });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "GPT Unavailable Unavailable" }).disabled).toBe(true);
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "ArrowUp" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "ArrowUp" });
    expect(document.activeElement).toBe(search);
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.click(last);
    expect(onChange).toHaveBeenCalledWith({ agent: "codex", model: "gpt-plus", effort: "high", fastMode: false });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("takes Add providers to Settings", async () => {
    mocks.call.mockImplementation(async (method: string) => {
      if (method === "agents.modelCatalog" || method === "agents.models.refresh") return { models, providers: [] };
      if (method === "system.info") return info;
      throw new Error(method);
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ModelPicker value={null} onChange={vi.fn()} />
      </QueryClientProvider>,
    );
    const trigger = await screen.findByRole("button", { name: /Choose a model/ });
    fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Add providers" }));
    expect(mocks.navigate).toHaveBeenCalledWith({ view: "settings" });
  });

  it("shows loading and a retryable error instead of an empty search result", async () => {
    let rejectLoad!: (error: Error) => void;
    mocks.call.mockImplementation((method: string) => {
      if (method === "system.info") return Promise.resolve(info);
      return new Promise((_, reject) => {
        rejectLoad = reject;
      });
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ModelPicker value={{ agent: "opencode", model: "retired/model", effort: null }} onChange={vi.fn()} showEffort={false} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "retired/model" }));
    fireEvent.change(screen.getByLabelText("Search models"), { target: { value: "OpenRouter" } });
    expect(screen.getByRole("status").textContent).toBe("Loading models…");
    expect(screen.queryByText("No models match.")).toBeNull();
    await act(async () => rejectLoad(new Error("Offline")));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not load models.");
    mocks.call.mockImplementation(async (method: string) => (method === "agents.modelCatalog" || method === "agents.models.refresh" ? { models, providers: [] } : info));
    fireEvent.click(screen.getByRole("button", { name: "Retry loading models" }));
    await screen.findByRole("button", { name: /Acme Fast/ });
    expect(screen.getByLabelText("Search models")).toHaveProperty("value", "OpenRouter");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "retired/model" })).toBeTruthy();
  });

  it("keeps cached choices visible when an open-triggered refresh fails", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["agents.modelCatalog", {}], { models, providers: [] });
    client.setQueryData(["system.info", {}], info);
    mocks.call.mockRejectedValue(new Error("Offline"));
    render(
      <QueryClientProvider client={client}>
        <ModelPicker value={null} onChange={vi.fn()} placeholder="Low-cost default" showEffort={false} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Low-cost default" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Showing the last loaded list"));
    fireEvent.click(screen.getByRole("button", { name: "OpenCode" }));
    fireEvent.change(screen.getByLabelText("Search models"), { target: { value: "OpenRouter" } });
    expect(screen.getByRole("button", { name: /Acme Fast/ })).toBeTruthy();
  });
});

it("force-refreshes the backend catalog, shows provider failures and preserves a saved model", async () => {
  const onChange = vi.fn();
  mocks.call.mockImplementation(async (method) => {
    if (method === "system.info") return info;
    return { models, providers: [{ agent: "claude", status: "stale", refreshedAt: 1, message: "CLI offline; showing the previous list." }] };
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ModelPicker value={{ agent: "codex", model: "saved-old-model", effort: "high" }} onChange={onChange} />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /saved-old-model/ }));
  await screen.findByText(/CLI offline/);
  expect(screen.getByText(/Saved model: saved-old-model/)).toBeTruthy();
  await waitFor(() => expect((screen.getByRole("button", { name: "Refresh models" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
  await waitFor(() => expect(mocks.call).toHaveBeenCalledWith("agents.models.refresh", {}));
  expect(onChange).not.toHaveBeenCalled();
});

it("shows the verified version after a refresh, keeps the pinned ID in the tooltip and leaves the saved choice alone", async () => {
  const onChange = vi.fn();
  const opus = (label: string): ModelOption => ({ id: "claude-opus-4-6", label, agent: "claude", isDefault: false, efforts: ["low", "medium"], defaultEffort: "medium" });
  const catalog = (label: string) => ({ models: [...models, opus(label)], providers: [{ agent: "claude", status: "ready", refreshedAt: 1, message: null }] });
  mocks.call.mockImplementation(async (method) => {
    if (method === "system.info") return info;
    if (method === "agents.models.refresh") return catalog("Opus 4.6");
    return catalog("Opus");
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ModelPicker value={{ agent: "claude", model: "claude-opus-4-6", effort: "low" }} onChange={onChange} />
    </QueryClientProvider>,
  );
  const trigger = await screen.findByRole("button", { name: "Opus Low" });
  expect(trigger.getAttribute("title")).toBe("Opus · claude-opus-4-6");
  fireEvent.click(trigger);
  await waitFor(() => expect((screen.getByRole("button", { name: "Refresh models" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
  await screen.findByRole("button", { name: "Opus 4.6 Low" });
  expect(screen.getByRole("button", { name: "Opus 4.6 Low" }).getAttribute("title")).toBe("Opus 4.6 · claude-opus-4-6");
  fireEvent.change(screen.getByLabelText("Search models"), { target: { value: "opus" } });
  expect(screen.getByRole("button", { name: "Opus 4.6" }).getAttribute("title")).toBe("claude-opus-4-6");
  expect(onChange).not.toHaveBeenCalled();
});

it("retains a saved selection when refresh marks its model unavailable and blocks Fast", async () => {
  const onChange = vi.fn();
  const model: ModelOption = { ...models[0]!, fastMode: { supported: true } };
  const unavailable = { ...model, unavailable: "Account quota ended." };
  mocks.call.mockImplementation(async (method) => {
    if (method === "system.info") return info;
    return { models: [method === "agents.models.refresh" ? unavailable : model], providers: [] };
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ModelPicker value={{ agent: "codex", model: "gpt", effort: "high", fastMode: true }} onChange={onChange} />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "GPT High" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Refresh models" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
  await screen.findByText("Account quota ended.");
  const selected = screen.getByRole("button", { name: "GPT Account quota ended." });
  expect(selected.getAttribute("aria-pressed")).toBe("true");
  expect((selected as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Fast mode" }).getAttribute("data-blocked")).toBe("true");
  expect(onChange).not.toHaveBeenCalled();
});

it("finds legacy models by search, labels them, and never picks one by default", async () => {
  const legacy: ModelOption = {
    id: "gpt-old",
    label: "GPT Old",
    agent: "codex",
    isDefault: false,
    efforts: [],
    defaultEffort: null,
    legacy: true,
    provider: { id: "codex", label: "ChatGPT account" },
  };
  const catalog = { models: [...models, legacy], providers: [] };
  expect(defaultChoice([legacy, { ...legacy, id: "gpt-older" }], "codex")).toBeNull();
  mocks.call.mockImplementation(async (method: string) => (method === "system.info" ? info : catalog));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ModelPicker value={{ agent: "codex", model: "gpt", effort: "low" }} onChange={vi.fn()} />
    </QueryClientProvider>,
  );
  const trigger = await screen.findByRole("button", { name: /GPT/ });
  fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 });
  fireEvent.click(trigger);
  expect(rows()).toEqual(["GPTdefault"]);
  fireEvent.change(screen.getByLabelText("Search models"), { target: { value: "old" } });
  expect(rows()).toEqual(["GPT Oldlegacy"]);
});
