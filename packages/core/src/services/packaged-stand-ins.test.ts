import { createRequire } from "node:module";
import { harnessCatalog, harnessIds } from "@openorc/protocol";
import { describe, expect, it } from "vitest";

const { providerCommands } = createRequire(import.meta.url)("../../../../scripts/fixtures/packaged-environment.cjs") as { providerCommands: Record<string, string> };

describe("packaged checks", () => {
  // Release builds launch the packaged app with an inert stand-in for every agent; one without a stand-in fails only there.
  it("give every agent in the catalog a stand-in for its command", () => {
    expect(providerCommands).toEqual(Object.fromEntries(harnessIds.map((id) => [id, harnessCatalog[id].cli.bin])));
  });
});
