// @vitest-environment jsdom
import type { Block } from "@openorc/client";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Card } from "./cards";
import { ActivityRow } from "./tools";

vi.mock("expo-haptics", () => ({ notificationAsync: () => undefined, impactAsync: () => undefined, NotificationFeedbackType: {}, ImpactFeedbackStyle: {} }));
vi.mock("expo-router", () => ({ router: { push: () => undefined } }));
vi.mock("./Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }));

const tile = vi.hoisted(() => ({ uri: vi.fn(() => new Promise<string>(() => {})) }));

vi.mock("../client", async () => {
  const { fakeLink } = await import("../test-fixtures/fake-link");
  return { useLinkRead: fakeLink().useLinkRead, assetUri: tile.uri };
});

afterEach(() => {
  cleanup();
  tile.uri.mockClear();
});

type Activity = Extract<Block, { kind: "activity" }>;

it("asks the Mac for a generated image by the agent's activity id, not the transcript's block id", () => {
  const block: Activity = {
    id: "activity-exec-1",
    kind: "activity",
    label: "Generated image",
    status: "success",
    text: "",
    activityKind: "image_generation",
    imagePath: "/Users/me/.codex/generated_images/a/exec-1.png",
  };
  render(<Card block={block} runId="run-1" />);
  expect(tile.uri).toHaveBeenCalledWith({ kind: "activity", runId: "run-1", activityId: "exec-1" });
});

it("shows an image the agent viewed, open by default, from the activity that recorded it", () => {
  const block: Activity = { id: "activity-exec-2", kind: "activity", label: "Viewing image", status: "success", text: "/tmp/shot.png", detail: { type: "imageView", path: "/tmp/shot.png" } };
  render(<ActivityRow block={block} runId="run-2" />);
  expect(screen.getByText("Viewed image")).toBeTruthy();
  expect(screen.getByText("shot.png")).toBeTruthy();
  expect(tile.uri).toHaveBeenCalledWith({ kind: "activity", runId: "run-2", activityId: "exec-2" });
});
