import { hostedControlReason, type HostedControl } from "@openorc/client";
import type { HostedCapabilities } from "@openorc/protocol";
import { expect, it } from "vitest";
import type { PanelPage } from "../lib/panel-tabs";
import type { PanelContext } from "./panel-tools";
import { hostedUnavailablePanel } from "./HostedUnavailablePanel";

const cloud = { kind: "thread", thread: { id: "cloud", owner: { brain: "hosted", reach: "live" } } } as unknown as PanelContext;
const mac = { kind: "thread", thread: { id: "mac", owner: null } } as unknown as PanelContext;
const tool = (name: string) => ({ kind: "tool", tool: name }) as PanelPage;
/** The reasons a thread's server gives, with `features` served. */
const served =
  (context: PanelContext, features: HostedCapabilities["features"] = {}) =>
  (control: HostedControl) =>
    hostedControlReason(context.kind === "thread" ? context.thread : null, control, { version: 1, features });

it("leaves a cloud thread's terminal to its own panel, which reads the server, and holds back a tool the cloud lacks", () => {
  expect(hostedUnavailablePanel(cloud, tool("terminal"), served(cloud))).toBeNull();
  expect(hostedUnavailablePanel(cloud, tool("changes"), served(cloud))).toBeNull();
  expect(hostedUnavailablePanel(cloud, tool("memory"), served(cloud))).not.toBeNull();
  expect(hostedUnavailablePanel(mac, tool("memory"), served(mac))).toBeNull();
});

it("opens a cloud thread's files once its server serves them, and holds them back before", () => {
  const file = { kind: "file", path: "README.md" } as unknown as PanelPage;
  expect(hostedUnavailablePanel(cloud, file, served(cloud))).not.toBeNull();
  expect(hostedUnavailablePanel(cloud, file, served(cloud, { fileBrowser: { available: true } }))).toBeNull();
  expect(hostedUnavailablePanel(cloud, tool("file"), served(cloud, { fileBrowser: { available: true } }))).toBeNull();
});
