# Running inside WSL

On Windows, OpenOrc can run inside a WSL distribution instead of on Windows itself. The window stays a Windows app; the core, which starts agents, runs Git and owns the ledger, runs inside the distribution. Agents, Git, `gh` and terminals are then the ones installed in the distribution, with the sign-ins they have there, and every project path is a Linux path. It is the arrangement VS Code uses for its WSL windows.

Nothing changes for anyone who does not choose a distribution. The setting appears only on a PC that has one.

## Using it

**Settings → General → Runs on** lists this PC and each installed distribution. Choosing a distribution restarts the core inside it and reloads the window. Each place keeps its own projects, conversations and settings: the list you see is the list of the place OpenOrc runs in.

On a first run, setup looks for agents where OpenOrc runs. **Look for agents on**, on its first screen, makes the same choice, so someone whose agents are installed only inside a distribution is not left with none found.

Choosing a folder for a project also switches. With OpenOrc on this PC, picking a project folder under `\\wsl.localhost\<distribution>\` (or `\\wsl$\`) offers to run inside that distribution and adds the folder as a project there; **Open from Windows** keeps the old behavior of opening the share with Windows' own tools. With OpenOrc in a distribution, the folder chooser opens in your home folder there, and picking a project folder outside the distribution offers to switch to where it lives. Only a folder chosen to become a project offers this. Any other folder, such as a skill's or a Slack entry point's, is one the place OpenOrc runs in uses itself: from this PC a folder inside a distribution opens through the share, and from inside a distribution a folder outside it is refused.

A switch waits for work to finish, and for more than an update does, because the place being left stays closed until you switch back: it is refused while agents are working, a terminal has a shell running, a queued message is being delivered, a title is being written or a Claude sign-in is open, and says which. Cloud conversations carry on in their sandboxes meanwhile. What runs only while OpenOrc runs in a place waits until you switch back to it: its schedules, its Slack connection and phone access.

The first start in a distribution installs what the core needs into `~/.openorc-wsl` there:

| Folder                  | Holds                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `node/<version>/`       | The core's own Node, downloaded from `nodejs.org` and checked against a SHA-256 pinned in the app. Your own Node is left alone. |
| `app/<version>/`        | The core this version of the app carries. A newer app's core removes the older one when it starts.                              |
| `brain/`                | The cloud brain the app installs, for Settings → Cloud.                                                                         |
| `profiles/<name>/data/` | A profile: the ledger, attachments, and managed workspaces.                                                                     |
| `setup.sh`              | The script the app installs and starts the core with. Rewritten at each start.                                                  |
| `core.lock`             | Held by the core while it runs, so a second one never runs beside it.                                                           |

The folder is readable by your account alone (mode 700), like the application data folder on Windows.

Removing `~/.openorc-wsl` removes OpenOrc from the distribution, its conversations there included. Secrets the core saves, such as a Slack token, stay on the Windows side under `%APPDATA%\OpenOrc\wsl\<distribution>\`, encrypted for your Windows account, as they are for OpenOrc on this PC.

A profile belongs to one application data folder on Windows, the one that keeps its secrets. The folder names its profile in a file called `wsl-profile`, written the first time OpenOrc runs in a distribution. A second data folder on the same PC, such as a development build's or a test's, so gets a profile of its own and never opens the first one's conversations.

Things removed from a project go to the distribution's own Trash (`~/.local/share/Trash`, by the freedesktop.org specification), since the Recycle Bin takes nothing from a distribution's disk.

## Requirements and limits

- An x64 distribution with glibc 2.28 or newer and `tar`: current Ubuntu, Debian, Fedora and their relatives. Alpine, which has no glibc, is refused with that reason.
- A connection to `nodejs.org` the first time, about 58 MB.
- Everything goes from Windows into the distribution, through `wsl.exe` and the share Windows mounts for it. A distribution with interop or its Windows drives switched off in `/etc/wsl.conf` works the same.
- Phone access listens inside the distribution, which a phone on your network cannot reach under WSL's default networking. Mirrored networking (`networkingMode=mirrored` in `.wslconfig`) makes it reachable.
- The Device panel has no simulators or emulators inside a distribution.
- Projects of this PC and of a distribution are separate lists. Showing both at once is not done yet.
- If the distribution is shut down while OpenOrc runs in it (`wsl --shutdown`), OpenOrc says so, with the last lines its core printed, and offers to try again or run on this PC. Only choosing **Run on this PC** changes the setting; closing the question quits, and the next start tries the distribution again.
- One core runs in a distribution at a time, whichever profile it opens. A second app that chooses the same distribution, or a start while the last core is still closing there, is refused with that reason. The lock uses `flock` from util-linux; a distribution without it starts the core unlocked and keeps the older versions of Node and the core it finds.

## How it works

Main decides where the core runs from `host.json` in the application data folder, read at each start; a missing file means this computer. For a distribution it starts the core through `wsl.exe --distribution <name> --cd ~ --exec …` and talks to it over that process's pipes in frames, one JSON document per line ([`wsl-frames.ts`](../apps/desktop/src/shared/wsl-frames.ts)). The core writes its frames on file descriptor 3 and has its standard output pointed at its error stream, so nothing an agent or tool prints can land between two frames.

Everything main does inside the distribution is a step of one script, `~/.openorc-wsl/setup.sh` ([`main/wsl/runtime.ts`](../apps/desktop/src/main/wsl/runtime.ts)): asking what is installed, unpacking an archive from its input, and starting the core. Main writes the script through the input of `tee` and starts each step with plain words for arguments, a step's name and a version, so nothing depends on how quotes survive a Windows command line on the way through `wsl.exe`.

A utility process is handed each window's `MessagePort`. A core inside a distribution cannot be, so main keeps the ports and relays each message ([`main/wsl/core.ts`](../apps/desktop/src/main/wsl/core.ts)). The private channel between main and the core, which carries protected storage, the Preview, presence and updates, rides the same pipes. On the core's side, [`core/serve.ts`](../apps/desktop/src/core/serve.ts) is the wiring both places share; [`core/index.ts`](../apps/desktop/src/core/index.ts) is the Electron entry and [`core/wsl/main.ts`](../apps/desktop/src/core/wsl/main.ts) the one for a distribution.

The core speaks only Linux paths. Main translates at the few places it opens files itself ([`main/host.ts`](../apps/desktop/src/main/host.ts)): the folder chooser, the file panel's viewer, image assets, project icons, **Show in Explorer**, and the Terminal panel, which starts `wsl.exe --cd <folder>` so the shell is the account's own login shell.

## Building and testing

`pnpm --filter @openorc/desktop bundle:wsl` builds the core for a distribution into `apps/desktop/dist/wsl/wsl-core-<version>.tgz`. It is a Linux x64 bundle with the cloud brain's native modules and is built on Linux or inside WSL, as the brain is. A build run from the repository reads it from there; a Windows package carries it in `resources/wsl`, and packaging for Windows refuses to continue without exactly one. The release workflow builds it once on its Linux job.

Development and QA builds can run the whole route on x64 Linux with glibc, where there is no `wsl.exe`, with this machine standing in for a distribution. That is the one machine the core for a distribution is built for; on macOS, or on another processor, the stand-in is offered and then refused as such a distribution would be.

```sh
pnpm --filter @openorc/desktop bundle:wsl
OPENORC_WSL_STANDIN=Ubuntu OPENORC_WSL_STANDIN_HOME=/tmp/standin-home pnpm dev
```

`OPENORC_WSL_STANDIN` names the stand-in, which then appears under **Runs on**; `OPENORC_WSL_STANDIN_HOME` gives it a home of its own, so nothing is installed into yours. Release builds ignore both.

The unit tests cover the frames, the relay, path translation, the distribution listing, the switch and its folder chooser, the core's lifecycle in main, and the installer, whose shell scripts run for real against a temporary home on x64 Linux with glibc and are skipped elsewhere. On a Windows PC, a packaged build has been taken by hand through first-run setup inside Ubuntu and into a conversation there: choosing the distribution, installing the core there, finding the agents installed there, adding a project, and running turns with the distribution's own Claude Code. The Terminal panel and the file panel's viewer have not been checked on Windows yet.
