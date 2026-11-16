import { expect, it } from "vitest";
import type { PanelPage } from "../lib/panel-tabs";
import type { PanelContext } from "./panel-tools";
import { hostedUnavailablePanel } from "./HostedUnavailablePanel";

const cloud = { kind: "thread", thread: { id: "cloud", owner: { brain: "hosted", reach: "live" } } } as unknown as PanelContext;
const mac = { kind: "thread", thread: { id: "mac", owner: null } } as unknown as PanelContext;
const tool = (name: string) => ({ kind: "tool", tool: name }) as PanelPage;

it("leaves a cloud thread's terminal to its own panel, which reads the server, and holds back a tool the cloud lacks", () => {
  expect(hostedUnavailablePanel(cloud, tool("terminal"))).toBeNull();
  expect(hostedUnavailablePanel(cloud, tool("changes"))).toBeNull();
  expect(hostedUnavailablePanel(cloud, tool("memory"))).not.toBeNull();
  expect(hostedUnavailablePanel(mac, tool("memory"))).toBeNull();
});
