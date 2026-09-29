// The disposable machine a packaged OpenOrc runs in for a check: its own HOME and profile, login files that resolve
// only inert provider stand-ins, and no inherited API keys, shell startup files, provider paths, or dev flags.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const windows = process.platform === "win32";
const linux = process.platform === "linux";

function packagedEnvironment() {
  assert.ok(windows || linux || process.platform === "darwin", "This launcher validates macOS, Windows and Linux packages");
  if (!windows) assert.ok(["/bin/zsh", "/bin/bash", "/bin/sh"].includes(os.userInfo().shell), "Disposable shell fixtures currently support zsh/bash/sh logins only");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openorc-packaged-smoke-"));
  const profile = path.join(root, "profile");
  const repository = path.join(root, "repository");
  for (const dir of [profile, repository, path.join(root, "tmp")]) fs.mkdirSync(dir);
  const fixtureBin = path.join(root, "bin");
  fs.mkdirSync(fixtureBin);
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
  for (const name of ["codex", "claude", "opencode"]) {
    if (windows) fs.copyFileSync(path.join(systemRoot, "System32/where.exe"), path.join(fixtureBin, `${name}.exe`));
    else fs.symlinkSync("/usr/bin/false", path.join(fixtureBin, name));
  }
  const git = windows ? execFileSync("where.exe", ["git.exe"], { encoding: "utf8" }).trim().split(/\r?\n/)[0] : "/usr/bin/git";
  const fixturePath = windows
    ? [fixtureBin, path.dirname(git), path.join(systemRoot, "System32"), systemRoot, path.join(systemRoot, "System32/WindowsPowerShell/v1.0")].join(path.delimiter)
    : `${fixtureBin}:/usr/bin:/bin:/usr/sbin:/sbin`;
  const shellProfile = `export PATH='${fixturePath.replaceAll("'", "'\\''")}'\n`;
  // The core deliberately rebuilds its login environment. Its disposable login
  // files must therefore resolve only our inert provider fixtures after refresh.
  if (!windows) for (const name of [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".profile", ".bash_profile", ".bashrc"]) fs.writeFileSync(path.join(root, name), shellProfile);
  const env = {
    HOME: root,
    ZDOTDIR: root,
    XDG_CONFIG_HOME: root,
    TMPDIR: path.join(root, "tmp"),
    PATH: fixturePath,
    ...(windows
      ? {
          SystemRoot: systemRoot,
          WINDIR: systemRoot,
          USERPROFILE: root,
          APPDATA: path.join(root, "AppData/Roaming"),
          LOCALAPPDATA: path.join(root, "AppData/Local"),
          TEMP: path.join(root, "tmp"),
          TMP: path.join(root, "tmp"),
          ComSpec: path.join(systemRoot, "System32/cmd.exe"),
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
        }
      : { SHELL: "/bin/sh" }),
    ...(linux ? displayEnvironment() : {}),
    LANG: "en_US.UTF-8",
    OPENORC_USER_DATA: profile,
    OPENORC_CODEX_BIN: windows ? path.join(fixtureBin, "codex.exe") : "/usr/bin/false",
    OPENORC_CLAUDE_BIN: windows ? path.join(fixtureBin, "claude.exe") : "/usr/bin/false",
    OPENORC_OPENCODE_BIN: windows ? path.join(fixtureBin, "opencode.exe") : "/usr/bin/false",
    OPENORC_RENDERER_LOG: "1",
  };
  // Windows resolves known folders only when they exist. Model a real user
  // profile before Electron asks for appData; keep both locations disposable.
  if (windows) for (const directory of [env.APPDATA, env.LOCALAPPDATA]) fs.mkdirSync(directory, { recursive: true });
  // Packages encrypt cookies with a key kept in the keychain and read it at startup. A HOME without a keychain would
  // block startup on a "Keychain Not Found" dialog, so the disposable HOME gets its own empty, unlocked default
  // keychain. macOS resolves the keychain list from HOME, so the user's own keychains are never touched.
  if (process.platform === "darwin") {
    const keychain = path.join(root, "Library/Keychains/login.keychain-db");
    fs.mkdirSync(path.dirname(keychain), { recursive: true });
    const security = (...args) => execFileSync("security", args, { env: { ...process.env, HOME: root }, stdio: "ignore" });
    security("create-keychain", "-p", "", keychain);
    security("default-keychain", "-d", "user", "-s", keychain);
    security("set-keychain-settings", keychain);
  }
  if (linux) Object.assign(env, disposableSecretService(root));
  return { root, profile, repository, fixtureBin, fixturePath, git, env };
}

/** The X display a Linux package opens its window on: the one this check runs under, such as xvfb-run's in CI. */
function displayEnvironment() {
  const authority = process.env.XAUTHORITY || path.join(os.homedir(), ".Xauthority");
  return { ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}), ...(fs.existsSync(authority) ? { XAUTHORITY: authority } : {}) };
}

/**
 * Linux keeps protected storage in the Secret Service. Where dbus-daemon and gnome-keyring-daemon are installed, the
 * disposable HOME gets its own session bus and an empty, unlocked keyring, so the user's own keyring is never touched.
 * Chromium uses the Secret Service only on desktops it recognizes, hence GNOME. Without both tools the package falls
 * back to plain-text storage, which OpenOrc refuses; the runtime smoke then reports that limit.
 */
function disposableSecretService(root) {
  const runtime = path.join(root, "run");
  fs.mkdirSync(runtime, { mode: 0o700 });
  const base = { HOME: root, XDG_RUNTIME_DIR: runtime, XDG_DATA_HOME: path.join(root, ".local/share"), PATH: "/usr/bin:/bin" };
  let bus;
  try {
    bus = execFileSync("dbus-daemon", ["--session", "--fork", "--print-address=1", "--print-pid=1"], { env: base, encoding: "utf8", timeout: 10_000 }).trim().split("\n");
  } catch {
    return {};
  }
  const [address, pid] = bus;
  // The keyring daemon leaves with the bus it serves.
  process.once("exit", () => {
    try {
      process.kill(Number(pid));
    } catch {
      /* Already gone. */
    }
  });
  const env = { DBUS_SESSION_BUS_ADDRESS: address, XDG_RUNTIME_DIR: runtime, XDG_CURRENT_DESKTOP: "GNOME" };
  try {
    // Creates and unlocks the login keyring with this password. An empty one creates no keyring at all.
    const password = "disposable-openorc-smoke-keyring";
    execFileSync("gnome-keyring-daemon", ["--unlock", "--components=secrets", "--daemonize"], { env: { ...base, ...env }, input: password, stdio: ["pipe", "ignore", "ignore"], timeout: 10_000 });
  } catch {
    return {};
  }
  return env;
}

/** The app's own executable inside a packaged macOS .app, or a Windows or Linux application directory. */
function packagedExecutable(appPath) {
  assert.ok(appPath && path.isAbsolute(appPath) && (windows || linux || appPath.endsWith(".app")), "Supply an absolute packaged application path");
  const executable = path.join(appPath, { win32: "OpenOrc.exe", linux: "openorc", darwin: "Contents/MacOS/OpenOrc" }[process.platform]);
  fs.accessSync(executable, fs.constants.X_OK);
  return executable;
}

module.exports = { windows, linux, packagedEnvironment, packagedExecutable };
