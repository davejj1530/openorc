import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Composer, type ComposerProps } from "./Composer";

afterEach(cleanup);

type Case = { queueing: boolean; liveByDefault: boolean; steerable: boolean; stop: "none" | "live" | "action"; draft: boolean };
const flags = [false, true];
const stops = ["none", "live", "action"] as const;
const cases: Case[] = flags.flatMap((queueing) =>
  flags.flatMap((liveByDefault) => flags.flatMap((steerable) => stops.flatMap((stop) => flags.map((draft) => ({ queueing, liveByDefault, steerable, stop, draft }))))),
);

/** What the composer offers, read off the screen: the primary button, the controls beside it, and what Enter sends. */
async function offered({ queueing, liveByDefault, steerable, stop, draft }: Case) {
  const onSubmit = vi.fn(async () => {});
  const props: ComposerProps = {
    value: draft ? "say something" : "",
    onChange: () => {},
    onSubmit,
    placeholder: "Message",
    model: null,
    onModel: () => {},
    mode: "act",
    onMode: () => {},
    permission: "trusted",
    onPermission: () => {},
    location: { label: null, branch: null },
    allowEmpty: true,
    queueing,
    liveByDefault,
    steerable,
    ...(stop === "live" ? { live: { runId: "run", working: true } } : {}),
    ...(stop === "action" ? { stopAction: { working: true, pending: false, onStop: () => {} } } : {}),
  };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Composer {...props} />
    </QueryClientProvider>,
  );
  const primary = document.querySelector(".composer-send")?.getAttribute("aria-label");
  const beside = ["Send now", "Queue", "Stop"].filter((name) => screen.queryAllByRole("button", { name }).some((button) => !button.classList.contains("composer-send")));
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Enter" });
  let enter: boolean | null = null;
  if (primary !== "Stop") {
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    enter = (onSubmit.mock.calls[0] as unknown[])[2] as boolean;
  }
  cleanup();
  return { primary, beside, enter };
}

it("offers the same controls for every mix of turn, steering, stop and draft", async () => {
  const seen: string[] = [];
  for (const one of cases) {
    const { primary, beside, enter } = await offered(one);
    seen.push(`${JSON.stringify(one)} -> ${primary} [${beside.join(", ")}] enter=${enter}`);
  }
  expect(seen).toMatchSnapshot();
});
