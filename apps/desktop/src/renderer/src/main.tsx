import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { StartupNotice } from "./components/StartupNotice";
import { core } from "./lib/rpc";
import { queryClient } from "./lib/query";
import { installAutorun } from "./lib/autorun";
import { installDiffRefresh } from "./lib/diff-refresh";
import { installNotifications } from "./lib/notifications";
import { installWindowState } from "./lib/window";
import "./lib/theme";
import "./lib/transcript";
import "./app.css";

installAutorun();
installDiffRefresh();
installNotifications();
installWindowState();
core.connect();

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      <StartupNotice />
    </QueryClientProvider>
  </StrictMode>,
);
