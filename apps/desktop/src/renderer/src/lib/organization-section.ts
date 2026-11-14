import { useRouter, type Route } from "./router";

export type OrganizationSection = "people" | "seats";
export const ORGANIZATION_SEATS_ENABLED = false;

export function organizationSection(route: Route, spaceId: string, admin: boolean): OrganizationSection {
  return admin && route.view === "people" && route.spaceId === spaceId && route.section === "seats" ? "seats" : "people";
}

export function useOrganizationSection(spaceId: string, admin: boolean) {
  const route = useRouter((state) => state.route);
  const section = organizationSection(route, spaceId, admin);
  const select = (next: OrganizationSection) => {
    if (next === "seats" && !admin) return;
    useRouter.getState().navigate({ view: "people", spaceId, ...(next === "seats" ? { section: "seats" } : {}) });
  };
  return { section, select };
}
