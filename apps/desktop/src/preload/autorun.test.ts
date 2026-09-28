import { describe, expect, it } from "vitest";
import { readAutorun } from "./autorun";

const switches: NodeJS.ProcessEnv = {
  OPENORC_AUTOBENCH: "1",
  OPENORC_AUTOBENCH_THREAD: "1",
  OPENORC_AUTORUN_CODEX: "1",
  OPENORC_AUTORUN_THREAD: "1",
  OPENORC_AUTORUN_CWD: "/tmp/repo",
  OPENORC_AUTORUN_PROMPT: "Delete everything",
  OPENORC_AUTORUN_AGENT: "codex",
  OPENORC_AUTORUN_MODEL: "gpt",
  OPENORC_AUTORUN_IMAGE: "/tmp/image.png",
  OPENORC_AUTODIFF: "1",
  OPENORC_AUTODIFF_MODE: "worker",
  OPENORC_ROUTE: "settings",
  OPENORC_THEME: "light",
};

describe("launch switches", () => {
  it("ignores every environment switch in a release build", () => {
    expect(readAutorun(switches, [], false)).toEqual({
      bench: false,
      threadBench: false,
      codex: false,
      thread: false,
      cwd: null,
      prompt: null,
      agent: null,
      model: null,
      image: null,
      diff: false,
      diffMode: "main",
      route: null,
      theme: null,
    });
  });

  it("keeps the route argument main passes to a second window", () => {
    expect(readAutorun(switches, ["--openorc-route=thread:t1"], false).route).toBe("thread:t1");
  });

  it("reads the environment switches in a QA build", () => {
    const autorun = readAutorun(switches, [], true);
    expect(autorun).toMatchObject({ codex: true, prompt: "Delete everything", diffMode: "worker", route: "settings", theme: "light" });
  });
});
