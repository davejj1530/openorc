import { OrganizationStorage } from "@openorc/protocol";
import type { Route } from "./wire.js";

export const organizationStorageRoute: Route<OrganizationStorage> = { method: "GET", path: "/organization/storage", reply: OrganizationStorage };
