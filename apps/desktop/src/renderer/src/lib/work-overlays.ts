import { useUi } from "./ui";

/** Closes the palette and the dialogs that stand over the work area. */
export const closeWorkOverlays = (): void =>
  useUi.setState({ palette: false, importProject: false, importSessions: { open: false }, deleteThreadId: null, moveThreadId: null, removeWorktreeThreadId: null, newFile: null });
