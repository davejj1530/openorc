import { readFileSync } from "node:fs";
import type { AppUpdater } from "electron-updater";
import { GitHubProvider } from "electron-updater/out/providers/GitHubProvider.js";
import { load } from "js-yaml";

type CustomOptions = Extract<Parameters<AppUpdater["setFeedURL"]>[0], { provider: "custom" }>;
type RuntimeOptions = ConstructorParameters<typeof GitHubProvider>[2];

/** Release eligibility follows GitHub; metadata always follows the installed architecture. */
export class ReleaseFeed extends GitHubProvider {
  private readonly metadataChannel: string;

  constructor(options: CustomOptions, updater: AppUpdater, runtime: RuntimeOptions) {
    const { owner, repo, channel } = options;
    if (typeof owner !== "string" || typeof repo !== "string" || typeof channel !== "string" || !/^latest-(arm64|x64)$/.test(channel)) {
      throw new Error("Invalid packaged GitHub update feed.");
    }
    super({ provider: "github", owner, repo, channel }, updater, runtime);
    this.metadataChannel = channel;
  }

  // electron-updater otherwise replaces latest-arm64 with beta for prereleases,
  // then falls back to latest. Neither filename identifies the Mac architecture.
  protected override getCustomChannelName(): string {
    return super.getCustomChannelName(this.metadataChannel);
  }

  protected override getDefaultChannelName(): string {
    return this.getCustomChannelName();
  }
}

/** Retain electron-builder's repository, signing metadata and cache configuration on disk. */
export function configureReleaseFeed(updater: Pick<AppUpdater, "setFeedURL">, configPath: string): string | null {
  try {
    const config = load(readFileSync(configPath, "utf8"));
    if (!config || typeof config !== "object" || !("provider" in config) || config.provider !== "github") throw new Error("Expected a packaged GitHub update feed.");
    updater.setFeedURL({ ...config, provider: "custom", updateProvider: ReleaseFeed });
    return null;
  } catch (error) {
    return `Updates are unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}
