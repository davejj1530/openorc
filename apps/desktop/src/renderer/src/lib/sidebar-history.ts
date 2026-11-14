import { create } from "zustand";

/** The measured sidebar header owns the one choice of where window history appears. */
export const useSidebarHistory = create(() => ({ fits: true }));
