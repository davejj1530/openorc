import type { ToolIconName } from "@openorc/client";
import { Check, FileText, Globe, Hammer, Search, WorkCommand, WorkDelegate, WorkEdit, WorkMessage, WorkRead, WorkSearch } from "./icons";

/** How the desktop draws each tool icon the transcript logic names. */
export const toolIcons: Record<ToolIconName, typeof Check> = { Check, FileText, Globe, Hammer, Search, WorkCommand, WorkDelegate, WorkEdit, WorkMessage, WorkRead, WorkSearch };
