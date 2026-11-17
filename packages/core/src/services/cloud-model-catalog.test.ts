import { CLOUD_DEFAULT_MODEL } from "@openorc/protocol";
import { expect, it } from "vitest";
import { cloudModelCatalog } from "./cloud-model-catalog.js";
import { acpOptions, claudeOptions, codexOptions } from "./run-catalog.js";

/*
 * The models OpenOrc Cloud runs, from each agent CLI's own listing on a cloud machine: mapped by the very code that maps
 * the same listing on this Mac, and an agent the cloud hasn't read offers its CLI's default alone.
 */
const readAt = "2026-11-18T02:00:00.000Z";
const claude = { models: [{ value: "claude-opus-5-5", displayName: "Opus 5.5", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"], supportsFastMode: true }] };
const codex = [{ id: "gpt-5.5", model: "gpt-5.5", displayName: "GPT-5.5", description: "", isDefault: true, hidden: false, efforts: ["medium", "high"], defaultEffort: "medium" }];
const opencode = [{ id: "openrouter/anthropic/claude-sonnet-5", label: "Sonnet 5", provider: { id: "openrouter", label: "OpenRouter" }, isDefault: true, efforts: [], defaultEffort: null }];

it("maps each agent's cloud listing as this Mac maps the same CLI's, with the CLI version the cloud runs", () => {
  const catalog = cloudModelCatalog({
    agents: [
      { agent: "claude", cliVersion: "2.1.300", readAt, listing: claude },
      { agent: "codex", cliVersion: "0.80.0", readAt, listing: codex },
      { agent: "opencode", cliVersion: "2.0.0", readAt, listing: opencode },
    ],
  });
  expect(catalog.models).toEqual([...claudeOptions(claude, "2.1.300", {}).models, ...codexOptions(codex), ...acpOptions("opencode", opencode, null)]);
  expect(catalog.models.some((model) => model.agent === "claude" && model.id === "claude-opus-5-5")).toBe(true);
  expect(catalog.providers).toEqual(["claude", "codex", "opencode"].map((agent) => ({ agent, status: "ready", refreshedAt: Date.parse(readAt), message: null })));
});

it("offers an agent the cloud hasn't read yet only its CLI's default, never this Mac's list or a written one", () => {
  const catalog = cloudModelCatalog({ agents: [{ agent: "codex", cliVersion: "0.80.0", readAt, listing: codex }] });
  const unread = catalog.models.filter((model) => model.agent !== "codex");
  expect(unread.map((model) => [model.agent, model.id, model.label, model.isDefault])).toEqual([
    ["claude", CLOUD_DEFAULT_MODEL, "Claude default", true],
    ["opencode", CLOUD_DEFAULT_MODEL, "OpenCode default", true],
  ]);
  expect(catalog.providers.find((provider) => provider.agent === "claude")).toMatchObject({ status: "fallback", refreshedAt: null });
});
