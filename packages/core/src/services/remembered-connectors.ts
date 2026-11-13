import { settings, type Db } from "@openorc/db";
import { Connector } from "@openorc/protocol";
import { z } from "zod";

const KEY = "connectors.remembered";
/** Folders whose lists are kept; the one read longest ago goes first. */
const KEPT = 8;
const Remembered = z.record(z.string(), z.array(Connector));

/** The connectors last read in each folder, so a fresh start shows them while it reads them again. */
export interface RememberedConnectors {
  load(folder: string): Connector[] | null;
  save(folder: string, connectors: Connector[]): void;
}

export const nothingRemembered: RememberedConnectors = { load: () => null, save: () => {} };

export function rememberedConnectors(db: Db): RememberedConnectors {
  // Written by an older build or damaged, an entry is dropped rather than trusted.
  const all = (): Record<string, Connector[]> => {
    try {
      return Remembered.parse(JSON.parse(settings.get(db, KEY) ?? "{}"));
    } catch {
      return {};
    }
  };
  return {
    load: (folder) => all()[folder] ?? null,
    save: (folder, connectors) => {
      const others = Object.entries(all()).filter(([key]) => key !== folder);
      settings.set(db, KEY, JSON.stringify(Object.fromEntries([...others.slice(-(KEPT - 1)), [folder, connectors]])));
    },
  };
}
