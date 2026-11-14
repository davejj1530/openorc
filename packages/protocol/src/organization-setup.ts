import { z } from "zod";
import type { GithubWork } from "./account.js";
import { SpaceId, type OrganizationIdentity } from "./spaces.js";

const name = z.string().max(1000);
const logo = z
  .string()
  .max(64_000)
  .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/);
const repository = z.object({ installationId: SpaceId, repoId: z.number().int().positive() }).strict();

export const AvailableGithubInstallation = z.object({
  installationId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  accountLogin: z.string(),
  accountType: z.enum(["User", "Organization"]),
});
export type AvailableGithubInstallation = z.infer<typeof AvailableGithubInstallation>;
export const GithubConnectChoice = z.object({ another: z.boolean().optional(), installationId: AvailableGithubInstallation.shape.installationId.optional() }).strict();
export type GithubConnectChoice = z.infer<typeof GithubConnectChoice>;

export interface OrganizationRepositories {
  configured: boolean;
  installations: { id: string; accountLogin: string; accountType: "User" | "Organization"; suspended: boolean; settingsUrl: string | null }[];
  available?: AvailableGithubInstallation[];
  repositories: { installationId: string; repoId: number; fullName: string; defaultBranch: string; private: boolean; projectId: string | null }[];
  connecting: GithubWork | null;
}
export type OrganizationProjectAdded = { installationId: string; repoId: number } & ({ state: "added"; projectId: string } | { state: "refused"; error: string });

export const organizationSetupParams = {
  "spaces.create": z.object({ name, logo: logo.optional() }).strict(),
  "organization.update": z
    .object({ spaceId: SpaceId, name: name.optional(), logo: logo.nullable().optional() })
    .strict()
    .refine((input) => input.name !== undefined || input.logo !== undefined, "Say what to change."),
  "organization.repositories": z.object({ spaceId: SpaceId }).strict(),
  "organization.github.connect": GithubConnectChoice.extend({ spaceId: SpaceId }),
  "organization.projects.add": z.object({ spaceId: SpaceId, repositories: z.array(repository).min(1).max(50) }).strict(),
};
export interface OrganizationSetupResults {
  "spaces.create": { spaceId: string; logoError: string | null };
  "organization.update": OrganizationIdentity;
  "organization.repositories": OrganizationRepositories;
  "organization.github.connect": OrganizationRepositories;
  "organization.projects.add": OrganizationProjectAdded[];
}
