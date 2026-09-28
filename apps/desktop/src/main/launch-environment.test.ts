import { describe, expect, it } from "vitest";
import { removeInjectedVariables } from "./launch-environment";

describe("launch environment", () => {
  it("removes the variables that make shells, Node, Git or the loader run extra code", () => {
    const env: NodeJS.ProcessEnv = {
      HOME: "/Users/someone",
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://proxy:8080",
      NODE_OPTIONS: "--require /tmp/payload.js",
      BASH_ENV: "/tmp/payload.sh",
      ENV: "/tmp/payload.sh",
      ZDOTDIR: "/tmp/zsh",
      PROMPT_COMMAND: "/tmp/payload.sh",
      DYLD_INSERT_LIBRARIES: "/tmp/payload.dylib",
      LD_PRELOAD: "/tmp/payload.so",
      GIT_CONFIG_PARAMETERS: "'core.fsmonitor=/tmp/payload.sh'",
      GIT_SSH_COMMAND: "/tmp/payload.sh",
    };

    expect(removeInjectedVariables(env)).toEqual(["BASH_ENV", "DYLD_INSERT_LIBRARIES", "ENV", "GIT_CONFIG_PARAMETERS", "GIT_SSH_COMMAND", "LD_PRELOAD", "NODE_OPTIONS", "PROMPT_COMMAND", "ZDOTDIR"]);
    expect(env).toEqual({ HOME: "/Users/someone", PATH: "/usr/bin", HTTPS_PROXY: "http://proxy:8080" });
  });

  it("leaves an ordinary environment unchanged", () => {
    const env: NodeJS.ProcessEnv = { HOME: "/Users/someone", LANG: "en_US.UTF-8", SHELL: "/bin/zsh" };
    expect(removeInjectedVariables(env)).toEqual([]);
    expect(env).toEqual({ HOME: "/Users/someone", LANG: "en_US.UTF-8", SHELL: "/bin/zsh" });
  });
});
