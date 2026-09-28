import type { OpenOrcApi } from "../shared/types";

declare global {
  interface Window {
    openorc: OpenOrcApi;
  }
}

export {};
