import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppUpdater } from "electron-updater";
import { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppUpdates } from "./app-updates";
import { configureReleaseFeed, ReleaseFeed } from "./release-feed";

class TestUpdater extends AppUpdater {
  feed!: ReleaseFeed;
  constructor(version: string, directory: string) {
    super(null, {
      version,
      name: "OpenOrc",
      isPackaged: true,
      appUpdateConfigPath: join(directory, "app-update.yml"),
      userDataPath: directory,
      baseCachePath: directory,
      whenReady: async () => {},
      relaunch: () => {},
      quit: () => {},
      onQuit: () => {},
    });
    this.logger = null;
  }
  protected override async getUpdateInfoAndProvider() {
    return { info: await this.feed.getLatestVersion(), provider: this.feed };
  }
  protected doDownloadUpdate = vi.fn<() => Promise<string[]>>().mockResolvedValue(["installer"]);
  quitAndInstall = vi.fn();
}

const directories: string[] = [];
const controllers: AppUpdates[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(installed: string, published: string, platform: "darwin" | "win32", arch: "arm64" | "x64") {
  const directory = mkdtempSync(join(tmpdir(), "openorc-feed-"));
  directories.push(directory);
  const updater = new TestUpdater(installed, directory);
  const controller = new AppUpdates(updater, null, async () => null);
  controllers.push(controller);
  const executor = new ElectronHttpExecutor();
  const root = "/owner/openorc/releases";
  const metadataPath = `${root}/download/v${published}/latest-${arch}${platform === "darwin" ? "-mac" : ""}.yml`;
  const artifact = `OpenOrc-${published}-${platform}-${arch}.${platform === "darwin" ? "zip" : "exe"}`;
  const request = vi.spyOn(executor, "request").mockImplementation(async (options) => {
    if (options.path === `${root}.atom`) {
      return `<feed><entry><title>OpenOrc ${published}</title><link href="https://github.com${root}/tag/v${published}"/><content>Release notes</content></entry></feed>`;
    }
    if (options.path === metadataPath) {
      return JSON.stringify({ version: published, files: [{ url: artifact, sha512: "fixture", size: 10 }], releaseDate: "2026-09-28T00:00:00Z" });
    }
    throw new Error(`Unexpected request: ${options.path}`);
  });
  updater.feed = new ReleaseFeed({ provider: "custom", owner: "owner", repo: "openorc", channel: `latest-${arch}` }, updater, {
    executor,
    platform,
    isUseMultipleRangeRequest: false,
  });
  return { updater, controller, request, metadataPath, artifact, directory };
}

describe("published release discovery with the installed electron-updater", () => {
  for (const [platform, arch] of [
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["win32", "x64"],
  ] as const) {
    it.each([
      ["0.1.0-beta.5", "0.1.0-beta.6"],
      ["0.1.0", "0.2.0-beta.1"],
      ["0.1.0-beta.5", "0.1.0"],
      ["0.1.0", "0.2.0"],
    ])(`${platform}-${arch}: offers %s → %s using the matching architecture metadata`, async (installed, published) => {
      const { updater, controller, request, metadataPath, artifact } = fixture(installed, published, platform, arch);
      const download = vi.spyOn(updater, "downloadUpdate");
      await controller.check();
      expect(controller.state).toEqual({ phase: "available", version: published });
      expect(request.mock.calls.map(([options]) => options.path)).toEqual(["/owner/openorc/releases.atom", metadataPath]);
      const info = await updater.feed.getLatestVersion();
      expect(updater.feed.resolveFiles(info)[0]?.url.href).toBe(`https://github.com/owner/openorc/releases/download/v${published}/${artifact}`);
      expect(download).not.toHaveBeenCalled();
      expect(updater.quitAndInstall).not.toHaveBeenCalled();
    });
  }

  it.each([
    ["0.1.0-beta.6", "0.1.0-beta.6"],
    ["0.1.0-beta.6", "0.1.0-beta.5"],
    ["0.1.0", "0.1.0-beta.6"],
    ["0.2.0-beta.1", "0.1.0"],
  ])("does not downgrade or reinstall %s when the newest published entry is %s", async (installed, published) => {
    const { controller } = fixture(installed, published, "darwin", "arm64");
    await controller.check();
    expect(controller.state).toEqual({ phase: "current" });
  });

  it("reports missing metadata rather than falling back to another architecture", async () => {
    const { controller, request } = fixture("0.1.0", "0.2.0-beta.1", "darwin", "arm64");
    const serve = request.getMockImplementation()!;
    request.mockImplementation((options, ...rest) => (options.path?.endsWith(".yml") ? Promise.reject(new Error("Missing metadata")) : serve(options, ...rest)));
    await controller.check();
    expect(controller.state).toEqual({ phase: "error", message: "Missing metadata" });
    expect(request.mock.calls.map(([options]) => options.path).filter((path) => path?.endsWith(".yml"))).toEqual([
      "/owner/openorc/releases/download/v0.2.0-beta.1/latest-arm64-mac.yml",
      "/owner/openorc/releases/download/v0.2.0-beta.1/latest-arm64-mac.yml",
    ]);
  });

  it("configures the custom provider from packaged YAML without rewriting signing or cache settings", () => {
    const { updater, directory } = fixture("0.1.0", "0.2.0-beta.1", "win32", "x64");
    const path = join(directory, "app-update.yml");
    const config = "provider: github\nowner: publisher\nrepo: release-repo\nchannel: latest-x64\npublisherName:\n  - Test Publisher\nupdaterCacheDirName: openorc-updater\n";
    writeFileSync(path, config);
    const setFeed = vi.spyOn(updater, "setFeedURL");
    expect(configureReleaseFeed(updater, path)).toBeNull();
    expect(setFeed).toHaveBeenCalledWith({
      provider: "custom",
      updateProvider: ReleaseFeed,
      owner: "publisher",
      repo: "release-repo",
      channel: "latest-x64",
      publisherName: ["Test Publisher"],
      updaterCacheDirName: "openorc-updater",
    });
    expect(updater.channel).toBeNull();
    expect(readFileSync(path, "utf8")).toBe(config);
    writeFileSync(path, "provider: github\nowner: publisher\nrepo: release-repo\nchannel: beta\n");
    expect(configureReleaseFeed(updater, path)).toContain("Invalid packaged GitHub update feed");
  });
});
