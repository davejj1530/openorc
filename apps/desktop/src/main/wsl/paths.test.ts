import { describe, expect, it } from "vitest";
import { parseWslPath, wslPaths } from "./paths";

describe("WSL paths", () => {
  it("reads the distribution and the path inside it from either share Windows offers", () => {
    expect(parseWslPath("\\\\wsl.localhost\\Ubuntu\\home\\me\\repo")).toEqual({ distro: "Ubuntu", path: "/home/me/repo" });
    expect(parseWslPath("\\\\wsl$\\Ubuntu-24.04\\home\\me")).toEqual({ distro: "Ubuntu-24.04", path: "/home/me" });
    expect(parseWslPath("\\\\WSL.LOCALHOST\\Ubuntu\\")).toEqual({ distro: "Ubuntu", path: "/" });
    expect(parseWslPath("//wsl.localhost/Ubuntu/home/me/")).toEqual({ distro: "Ubuntu", path: "/home/me" });
  });

  it("reads nothing from a path outside every distribution", () => {
    expect(parseWslPath("C:\\Users\\me\\repo")).toBeNull();
    expect(parseWslPath("\\\\fileserver\\share\\repo")).toBeNull();
    expect(parseWslPath("\\\\wsl.localhost\\")).toBeNull();
    expect(parseWslPath("/home/me/repo")).toBeNull();
  });

  it("names a path inside the distribution as Windows opens it", () => {
    const paths = wslPaths("Ubuntu");
    expect(paths.toWindows("/home/me/repo")).toBe("\\\\wsl$\\Ubuntu\\home\\me\\repo");
    expect(paths.toWindows("/home/me/../me/repo/")).toBe("\\\\wsl$\\Ubuntu\\home\\me\\repo");
    expect(paths.toWindows("/")).toBe("\\\\wsl$\\Ubuntu\\");
    expect(wslPaths("Ubuntu", "\\\\wsl.localhost\\").toWindows("/tmp")).toBe("\\\\wsl.localhost\\Ubuntu\\tmp");
  });

  it("takes a Windows path back only when it is inside this distribution, whatever its case", () => {
    const paths = wslPaths("Ubuntu");
    expect(paths.toLinux("\\\\wsl.localhost\\ubuntu\\home\\me")).toBe("/home/me");
    expect(paths.toLinux("\\\\wsl$\\Ubuntu\\home\\me")).toBe("/home/me");
    expect(paths.toLinux("\\\\wsl.localhost\\Debian\\home\\me")).toBeNull();
    expect(paths.toLinux("C:\\Users\\me")).toBeNull();
  });

  it("carries a name Windows cannot spell there and back", () => {
    const paths = wslPaths("Ubuntu");
    const linux = '/home/me/notes: "draft" <v2>?.md';
    const windows = paths.toWindows(linux);
    expect(windows.slice("\\\\wsl$\\Ubuntu\\home\\me\\".length)).not.toMatch(/[<>:"\\|?*]/);
    expect(paths.toLinux(windows)).toBe(linux);
  });
});
