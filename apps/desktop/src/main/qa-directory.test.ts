import { describe, expect, it } from "vitest";
import { qaDirectory } from "./qa-directory";

const directories = new Set(["/Users/d/repo"]);
const isDirectory = (path: string) => directories.has(path);

describe("qa directory", () => {
  it("never answers the chooser in a release build", () => {
    expect(qaDirectory({ OPENORC_QA_DIRECTORY: "/Users/d/repo" }, isDirectory)).toBeNull();
    expect(qaDirectory({ OPENORC_QA_DIRECTORY: process.cwd() })).toBeNull();
  });

  it("falls through to the native chooser when the variable is unset", () => {
    expect(qaDirectory({}, isDirectory, true)).toBeNull();
    expect(qaDirectory({ OPENORC_QA_DIRECTORY: "" }, isDirectory, true)).toBeNull();
  });

  it("falls through when the path is relative, missing, or not a directory", () => {
    expect(qaDirectory({ OPENORC_QA_DIRECTORY: "repo" }, isDirectory, true)).toBeNull();
    expect(qaDirectory({ OPENORC_QA_DIRECTORY: "/Users/d/gone" }, isDirectory, true)).toBeNull();
    expect(qaDirectory({ OPENORC_QA_DIRECTORY: "/Users/d/repo/README.md" }, isDirectory, true)).toBeNull();
  });

  it("checks the real filesystem by default", () => {
    expect(qaDirectory({ OPENORC_QA_DIRECTORY: process.cwd() }, undefined, true)).toBe(process.cwd());
    expect(qaDirectory({ OPENORC_QA_DIRECTORY: `${process.cwd()}/package.json` }, undefined, true)).toBeNull();
  });
});
