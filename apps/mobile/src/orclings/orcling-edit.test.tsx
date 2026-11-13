// @vitest-environment jsdom
import { ORCLING_BODY_COLORS, ORCLING_SHAPES } from "@openorc/client";
import { defaultOrclingLook, type ClaudeAccountConnection, type ModelOption, type Orcling, type OrclingDraft, type OrclingProfile } from "@openorc/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeMac } from "../test-fixtures/fake-mac";
import { alerts, nativeProps } from "../test-fixtures/react-native";

const mac = vi.hoisted(() => ({
  phone: null as unknown as FakeMac,
  profile: null as unknown as OrclingProfile,
  calls: [] as { method: string; params: unknown }[],
  refuse: null as string | null,
  /** While set, each update waits here until the test releases it. */
  held: null as (() => void)[] | null,
}));
vi.mock("../client", async () => {
  const { fakeMac } = await import("../test-fixtures/fake-mac");
  const claude: ModelOption = { id: "opus", label: "Opus", agent: "claude", isDefault: true, efforts: ["high"], defaultEffort: "high" };
  const codex: ModelOption[] = [
    { id: "gpt-6-astra", label: "GPT-6 Astra", agent: "codex", isDefault: true, efforts: ["low", "high"], defaultEffort: "high" },
    { id: "gpt-6-terra", label: "GPT-6 Terra", agent: "codex", isDefault: false, efforts: ["low", "high"], defaultEffort: "high" },
  ];
  const account = (id: string, name: string): ClaudeAccountConnection => ({ id, name, kind: "managed", enabled: true, createdAt: 1, status: "ready", email: null, organization: null, message: null });
  mac.phone = fakeMac(async (method, params) => {
    mac.calls.push({ method, params });
    if (method === "orclings.profile") return mac.profile;
    if (method === "agents.models") return [claude, ...codex];
    if (method === "claude.accounts.list") return { defaultId: "personal", accounts: [account("personal", "Personal"), account("work", "Work")] };
    if (method === "orclings.update") {
      if (mac.held) await new Promise<void>((release) => mac.held!.push(release));
      if (mac.refuse) throw new Error(mac.refuse);
      const { draft } = params as { draft: OrclingDraft };
      mac.profile = { ...mac.profile, ...draft, claudeAccountId: draft.claudeAccountId ?? mac.profile.claudeAccountId };
      return { ...mac.profile, threadId: "home-pip", createdAt: 1, updatedAt: 2 } satisfies Orcling;
    }
    if (method === "orclings.instructions.save") {
      const { body } = params as { body: string };
      mac.profile = { ...mac.profile, instructions: body };
      return { version: 2, body, author: "user", note: null, createdAt: 3 };
    }
    if (method === "orclings.delete") return null;
    if (method === "orclings.chats") return [{ id: "rex", name: "Rex", look: defaultOrclingLook, threadId: "home-rex", thread: null, last: null }];
    if (method === "agents.availability") return [{ id: "codex", state: "ready" }];
    if (method === "app.settings.get") return { defaultWorkspaceMode: "worktree", defaultPermissionMode: "review", defaultHarness: "codex" };
    if (method === "orclings.create") {
      const { draft } = params as { draft: OrclingDraft };
      return { ...draft, id: "new", claudeAccountId: "personal", threadId: "home-new", wakes: [], createdAt: 1, updatedAt: 1 } satisfies Orcling;
    }
    throw new Error(`no ${method}`);
  });
  return mac.phone.module;
});
const params = vi.hoisted(() => ({ id: "pip", composerId: "orcling:pip" }));
vi.mock("expo-router", () => {
  const Stack = ({ children }: { children?: ReactNode }) => <>{children}</>;
  Stack.Screen = () => null;
  return { router: { push: vi.fn(), back: vi.fn(), dismissTo: vi.fn() }, Stack, useLocalSearchParams: () => params };
});
vi.mock("../thread/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <span>{text}</span> }));
vi.mock("react-native-keyboard-controller", () => ({ useKeyboardState: <T,>(select: (state: { isVisible: boolean; height: number }) => T) => select({ isVisible: false, height: 0 }) }));

const { OrclingSheet } = await import("./OrclingSheet");
const { LookSheet } = await import("./LookSheet");
const { InstructionsSheet } = await import("./InstructionsSheet");
const { ModelSheet } = await import("../composer/ModelSheet");
const { queueSave } = await import("./orcling-edit");
const { NewOrclingSheet } = await import("./NewOrclingSheet");

const pip: OrclingProfile = {
  id: "pip",
  name: "Pip",
  look: defaultOrclingLook,
  settings: { agent: "codex", model: "gpt-6-astra", effort: "high", fastMode: false },
  permission: "approve",
  claudeAccountId: "personal",
  wakes: [],
  instructions: "Ping me when CI breaks.",
  memories: [],
};
const updates = () => mac.calls.filter((call) => call.method === "orclings.update").map((call) => (call.params as { draft: OrclingDraft }).draft);
const press = (title: string, button: string, typed?: string) => act(() => alerts.findLast((alert) => alert.title === title)!.buttons!.find((each) => each.text === button)!.onPress!(typed));

beforeEach(() => {
  mac.profile = { ...pip };
  mac.calls = [];
  mac.refuse = null;
  mac.held = null;
  alerts.length = 0;
  mac.phone.module.queryClient.clear();
  vi.mocked(router.push).mockClear();
  vi.mocked(router.back).mockClear();
  vi.mocked(router.dismissTo).mockClear();
});
afterEach(() => {
  cleanup();
  // A save left waiting would hold every later save of the same Orcling in the module's queue.
  mac.held?.splice(0).forEach((release) => release());
});

describe("changing an Orcling on the phone", () => {
  it("saves its permission and then its name as whole drafts, the second on top of the first, without touching its account", async () => {
    render(<OrclingSheet />, { wrapper: mac.phone.wrapper });
    fireEvent.click(await screen.findByRole("button", { name: "Permission, Approve" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitemradio", { name: "Allow" }));
    fireEvent.click(screen.getByRole("button", { name: "Name, Pip" }));
    expect(alerts.at(-1)).toMatchObject({ title: "Rename Orcling", defaultValue: "Pip" });
    press("Rename Orcling", "Save", "  Pippa ");
    await waitFor(() => expect(updates()).toHaveLength(2));
    expect(updates()).toEqual([
      { name: "Pip", look: defaultOrclingLook, settings: pip.settings, permission: "allow" },
      { name: "Pippa", look: defaultOrclingLook, settings: pip.settings, permission: "allow" },
    ]);
    expect(await screen.findByRole("button", { name: "Name, Pippa" })).toBeTruthy();
  });

  it("puts a name the Mac refuses back and says why", async () => {
    mac.refuse = "Wait for Pip to finish before renaming it.";
    render(<OrclingSheet />, { wrapper: mac.phone.wrapper });
    fireEvent.click(await screen.findByRole("button", { name: "Name, Pip" }));
    press("Rename Orcling", "Save", "Pippa");
    await waitFor(() => expect(alerts.at(-1)).toMatchObject({ title: "Couldn’t save", message: "Wait for Pip to finish before renaming it." }));
    expect(await screen.findByRole("button", { name: "Name, Pip" })).toBeTruthy();
  });

  it("says before sending that another Orcling has the name, whatever its case or punctuation", async () => {
    render(<OrclingSheet />, { wrapper: mac.phone.wrapper });
    await screen.findByRole("button", { name: "Name, Pip" });
    await waitFor(() => expect(mac.phone.module.queryClient.getQueryData(["orclings.chats", {}])).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Name, Pip" }));
    press("Rename Orcling", "Save", "REX!");
    expect(alerts.at(-1)).toMatchObject({ title: "Choose another name", message: "You already have an Orcling named Rex." });
    expect(updates()).toEqual([]);
  });

  it("changes its model and Claude account through the composer's model sheet", async () => {
    render(
      <>
        <OrclingSheet />
        <ModelSheet />
      </>,
      { wrapper: mac.phone.wrapper },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Model, GPT-6 Astra · High" }));
    expect(router.push).toHaveBeenCalledWith({ pathname: "/model", params: { composerId: "orcling:pip" } });
    fireEvent.click(await screen.findByRole("radio", { name: "GPT-6 Terra" }));
    await waitFor(() => expect(updates().at(-1)?.settings).toEqual({ agent: "codex", model: "gpt-6-terra", effort: "high", fastMode: false }));
    expect(await screen.findByRole("button", { name: "Model, GPT-6 Terra · High" })).toBeTruthy();
  });

  it("moves it to another Claude account from the model sheet's account menu, keeping its model", async () => {
    render(
      <>
        <OrclingSheet />
        <ModelSheet />
      </>,
      { wrapper: mac.phone.wrapper },
    );
    fireEvent.click(await screen.findByRole("tab", { name: "Claude" }));
    fireEvent.click(await screen.findByRole("button", { name: "Claude account, Personal" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Work" }));
    await waitFor(() => expect(updates()).toEqual([{ name: "Pip", look: defaultOrclingLook, settings: pip.settings, permission: "approve", claudeAccountId: "work" }]));
    expect(await screen.findByRole("button", { name: "Claude account, Work" })).toBeTruthy();
  });

  it("sends a change only once the one before it has answered, and builds on what that one saved", async () => {
    const sent: OrclingDraft[] = [];
    const answers: ((orcling: Orcling) => void)[] = [];
    const send = (draft: OrclingDraft) => {
      sent.push(draft);
      return new Promise<Orcling>((resolve) => answers.push(resolve));
    };
    const read = () => pip;
    const first = queueSave("pip", { permission: "allow" }, read, send);
    const second = queueSave("pip", { name: "Pippa" }, read, send);
    await Promise.resolve();
    expect(sent.map((draft) => [draft.name, draft.permission])).toEqual([["Pip", "allow"]]);
    answers[0]!({ ...pip, permission: "allow", threadId: "home-pip", createdAt: 1, updatedAt: 2 });
    await first;
    await waitFor(() => expect(sent).toHaveLength(2));
    expect([sent[1]!.name, sent[1]!.permission]).toEqual(["Pippa", "allow"]);
    answers[1]!({ ...pip, name: "Pippa", permission: "allow", threadId: "home-pip", createdAt: 1, updatedAt: 3 });
    await second;
  });

  it("keeps showing the newest choice while earlier saves of the same field answer", async () => {
    mac.held = [];
    render(<OrclingSheet />, { wrapper: mac.phone.wrapper });
    const choose = async (from: string, to: string) => {
      fireEvent.click(await screen.findByRole("button", { name: `Permission, ${from}` }));
      fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitemradio", { name: to }));
      fireEvent.click(screen.getByRole("button", { name: `Permission, ${to}` }));
    };
    await choose("Approve", "Allow");
    await choose("Allow", "Approve");
    await choose("Approve", "Allow");
    const release = async () => {
      await waitFor(() => expect(mac.held!.length).toBeGreaterThan(0));
      act(() => mac.held!.shift()!());
    };
    await release();
    await release();
    await waitFor(() => expect(updates()).toHaveLength(2));
    await act(() => new Promise((tick) => setTimeout(tick, 0)));
    expect(screen.getByRole("button", { name: "Permission, Allow" })).toBeTruthy();
    await release();
    await waitFor(() => expect(updates().map((draft) => draft.permission)).toEqual(["allow", "approve", "allow"]));
    expect(await screen.findByRole("button", { name: "Permission, Allow" })).toBeTruthy();
  });

  it("builds the next save on the Mac's Orcling once one fails, not on the change it refused", async () => {
    const sent: OrclingDraft[] = [];
    const send = (draft: OrclingDraft) => {
      sent.push(draft);
      return sent.length === 1 ? Promise.reject(new Error("Refused")) : Promise.resolve({ ...pip, ...draft, threadId: "home-pip", createdAt: 1, updatedAt: 2 });
    };
    const first = queueSave("pip", { name: "Taken" }, () => pip, send);
    const second = queueSave("pip", { permission: "allow" }, () => pip, send);
    await expect(first).rejects.toThrow("Refused");
    await second;
    expect(sent.map((draft) => [draft.name, draft.permission])).toEqual([
      ["Taken", "approve"],
      ["Pip", "allow"],
    ]);
  });

  it("redraws its look in its own sheet and saves it only on Save", async () => {
    render(<LookSheet />, { wrapper: mac.phone.wrapper });
    const shape = ORCLING_SHAPES.length - 1;
    fireEvent.click(await screen.findByRole("radio", { name: ORCLING_SHAPES[shape]!.name }));
    fireEvent.click(screen.getByRole("radio", { name: ORCLING_BODY_COLORS[0]!.name }));
    expect(updates()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(alerts.at(-1)).toMatchObject({ title: "Discard this look?" });
    expect(router.back).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(router.back).toHaveBeenCalled());
    expect(updates()).toEqual([{ name: "Pip", look: { ...defaultOrclingLook, shape, bodyColor: ORCLING_BODY_COLORS[0]!.hex }, settings: pip.settings, permission: "approve" }]);
  });

  it("rewrites its instructions in their own sheet, and sends instructions holding a secret to the Mac instead", async () => {
    const { unmount } = render(<OrclingSheet />, { wrapper: mac.phone.wrapper });
    fireEvent.click(await screen.findByRole("button", { name: "Edit Pip’s instructions" }));
    expect(router.push).toHaveBeenCalledWith({ pathname: "/orcling-instructions", params: { id: "pip" } });
    unmount();

    render(<InstructionsSheet />, { wrapper: mac.phone.wrapper });
    const field = await screen.findByLabelText("Pip’s instructions");
    act(() => (nativeProps.get(field)!["onChangeText"] as (text: string) => void)("Text me when CI breaks, once."));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(router.back).toHaveBeenCalled());
    expect(mac.calls.find((call) => call.method === "orclings.instructions.save")?.params).toEqual({ id: "pip", body: "Text me when CI breaks, once." });
    cleanup();

    vi.mocked(router.push).mockClear();
    mac.profile = { ...pip, instructions: "Deploy with [redacted:github-token]." };
    mac.phone.module.queryClient.clear();
    render(<OrclingSheet />, { wrapper: mac.phone.wrapper });
    fireEvent.click(await screen.findByRole("button", { name: "Edit Pip’s instructions" }));
    expect(alerts.at(-1)).toMatchObject({ title: "Edit these on your Mac" });
    expect(router.push).not.toHaveBeenCalled();
  });

  it("deletes it after asking, then goes Home", async () => {
    render(<OrclingSheet />, { wrapper: mac.phone.wrapper });
    fireEvent.click(await screen.findByRole("button", { name: "Delete Pip" }));
    expect(mac.calls.some((call) => call.method === "orclings.delete")).toBe(false);
    press("Delete Pip?", "Delete");
    await waitFor(() => expect(router.dismissTo).toHaveBeenCalledWith("/"));
    expect(mac.calls.find((call) => call.method === "orclings.delete")?.params).toEqual({ id: "pip" });
  });

  it("makes a new Orcling on the Mac's default model, working without asking, refusing a name another Orcling has, then opens its chat", async () => {
    render(<NewOrclingSheet />, { wrapper: mac.phone.wrapper });
    expect(await screen.findByRole("button", { name: "Model, GPT-6 Astra · High" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Permission, Allow" })).toBeTruthy();
    const name = screen.getByLabelText("Name");
    act(() => (nativeProps.get(name)!["onChangeText"] as (text: string) => void)("rex!"));
    expect(await screen.findByText("You already have an Orcling named Rex.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create Orcling" }));
    act(() => (nativeProps.get(name)!["onChangeText"] as (text: string) => void)("Nova"));
    fireEvent.click(screen.getByRole("radio", { name: ORCLING_SHAPES[1]!.name }));
    fireEvent.click(screen.getByRole("button", { name: "Create Orcling" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith({ pathname: "/thread/[id]", params: { id: "home-new" } }));
    expect(router.back).toHaveBeenCalled();
    expect(mac.calls.filter((call) => call.method === "orclings.create").map((call) => call.params)).toEqual([
      { draft: { name: "Nova", look: { ...defaultOrclingLook, shape: 1 }, settings: { agent: "codex", model: "gpt-6-astra", effort: "high", fastMode: false }, permission: "allow" } },
    ]);
  });
});
