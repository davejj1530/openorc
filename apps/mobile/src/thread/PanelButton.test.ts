import { expect, it } from "vitest";
import { panelButtonLabel } from "./PanelButton";

it("tells VoiceOver the panel's tools and, when there are any, how many files wait to be committed", () => {
  expect(panelButtonLabel({ label: "Changes", count: 0 })).toBe("Changes");
  expect(panelButtonLabel({ label: "Changes", count: 1 })).toBe("Changes, 1 file");
  expect(panelButtonLabel({ label: "Changes", count: 12 })).toBe("Changes, 12 files");
});
