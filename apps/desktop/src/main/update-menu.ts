import { app, dialog, Menu, type MenuItemConstructorOptions } from "electron";
import type { AppUpdates, UpdateState } from "./app-updates";

function label(state: UpdateState): string {
  switch (state.phase) {
    case "checking":
      return "Checking for updates…";
    case "available":
      return `Download OpenOrc ${state.version}…`;
    case "downloading":
      return `Downloading update… ${Math.round(state.percent ?? 0)}%`;
    case "ready":
      return `Restart to install OpenOrc ${state.version}…`;
    case "installing":
      return "Preparing update…";
    case "install-error":
      return "Update installation failed…";
    default:
      return "Check for updates…";
  }
}

/** Native controls stay available even if the renderer is reloading or has closed its last window. */
export function installUpdateMenu(updates: AppUpdates): () => void {
  let dialogOpen = false;
  let reportedInstallError = false;
  const show = async (message: string, detail: string, buttons = ["OK"]) =>
    (await dialog.showMessageBox({ type: "info", title: "OpenOrc updates", message, detail, buttons, defaultId: 0, cancelId: buttons.length - 1 })).response;

  const showInstallError = async () => {
    const state = updates.state;
    if (state.phase !== "install-error" || reportedInstallError || dialogOpen) return;
    reportedInstallError = true;
    dialogOpen = true;
    await show("The update could not be installed", `${state.message}\n\nWhen your work has finished, quit and reopen OpenOrc before trying again.`);
    dialogOpen = false;
  };

  const interact = async () => {
    if (dialogOpen) return;
    dialogOpen = true;
    try {
      // This item's available-state action is Download, so keep the known release usable even offline.
      if (updates.state.phase !== "available") await updates.check();
      let state = updates.state;
      if (state.phase === "disabled") await show("Updates are unavailable in this build", state.reason);
      else if (state.phase === "current") await show("OpenOrc is up to date", `You’re running OpenOrc ${app.getVersion()}.`);
      else if (state.phase === "error") await show("Couldn’t check for updates", `${state.message}\n\nTry Check for updates again when you’re connected.`);
      else if (state.phase === "available") {
        const detail = [`You’re running ${app.getVersion()}. Downloading will not interrupt your work.`, state.checkError].filter(Boolean).join("\n\n");
        const choice = await show(`OpenOrc ${state.version} is available`, detail, ["Download update", "Later"]);
        if (choice !== 0) return;
        await updates.download();
        state = updates.state;
        if (state.phase === "available" && state.error) await show("Couldn’t download the update", `${state.error}\n\nUse the update menu to retry.`);
      }
      state = updates.state;
      if (state.phase === "ready") {
        const choice = await show(`OpenOrc ${state.version} is ready`, "Restart to install the update. Finish agent work and close running terminal panels first.", ["Restart and install", "Later"]);
        if (choice !== 0) return;
        await updates.install();
        const next = updates.state;
        if (next.phase === "ready" && next.error) await show("OpenOrc is still working", next.error);
      }
    } finally {
      dialogOpen = false;
      void showInstallError();
    }
  };

  const updateItem: MenuItemConstructorOptions = { id: "app-update", label: label(updates.state), click: () => void interact() };
  const mac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: "OpenOrc",
            submenu: [
              { role: "about" },
              updateItem,
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    { role: "help", submenu: mac ? [] : [updateItem, { type: "separator" }, { role: "about" }] },
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  const refresh = (state: UpdateState) => {
    const item = menu.getMenuItemById("app-update");
    if (item) {
      item.label = label(state);
      item.enabled = !["checking", "downloading", "installing"].includes(state.phase);
    }
    if (state.phase === "install-error") void showInstallError();
  };
  refresh(updates.state);
  return updates.subscribe(refresh);
}
