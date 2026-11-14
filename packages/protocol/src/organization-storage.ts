import { z } from "zod";

export const OrganizationStorage = z.object({ usedBytes: z.number().int().nonnegative().safe(), allowanceBytes: z.number().int().nonnegative().safe() });
export type OrganizationStorage = z.infer<typeof OrganizationStorage>;

export interface OrganizationStorageRead {
  storage: OrganizationStorage | null;
  error: string | null;
}

export const organizationStorageRpcParams = {
  "organization.storage.get": z.strictObject({ spaceId: z.string().min(1) }),
};
export interface OrganizationStorageRpcResults {
  "organization.storage.get": OrganizationStorageRead;
}
