import type { OrganizationStorageRead } from "@openorc/protocol";

export function createOrganizationStorageHandlers(service: { storage(spaceId: string): Promise<OrganizationStorageRead> } | null) {
  return {
    "organization.storage.get": ({ spaceId }: { spaceId: string }): Promise<OrganizationStorageRead> => {
      if (!service) throw new Error("Organization storage isn't available here.");
      return service.storage(spaceId);
    },
  };
}
