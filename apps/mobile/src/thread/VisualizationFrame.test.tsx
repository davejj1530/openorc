// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { nativeProps } from "../test-fixtures/react-native";
import { WebKitWarmUp } from "./VisualizationFrame";

afterEach(cleanup);

const page = () => screen.queryByRole("document");

it("starts WebKit once per session on a hidden empty page in the visualizations' sandbox", () => {
  render(<WebKitWarmUp />);
  const view = nativeProps.get(page()!)!;
  expect(view).toMatchObject({ sandboxed: true, incognito: true, source: { html: "", baseUrl: "about:blank" } });
  const guard = view.onShouldStartLoadWithRequest as (request: { url: string; isTopFrame: boolean }) => boolean;
  expect(guard({ url: "about:blank", isTopFrame: true })).toBe(true);
  expect(guard({ url: "about:blank", isTopFrame: true })).toBe(false);
  act(() => (view.onLoadEnd as () => void)());
  expect(page()).toBeNull();
  cleanup();
  // Another thread with visualizations later in the session finds WebKit warm.
  render(<WebKitWarmUp />);
  expect(page()).toBeNull();
});
