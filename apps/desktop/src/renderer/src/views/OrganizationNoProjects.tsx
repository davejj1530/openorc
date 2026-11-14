import type { OrganizationIdentity } from "@openorc/protocol";
import { OrganizationMark } from "../components/OrganizationMark";
import { Button } from "../components/ui";
import "../components/Organization.css";

/** New members and open tabs that lost access share the same quiet work-column body. */
export function OrganizationNoProjects({ organization, lost = false, onPeople }: { organization: OrganizationIdentity; lost?: boolean; onPeople(): void }) {
  return (
    <div className="organization-empty flex-1">
      <div className="organization-empty-content">
        <div className="organization-empty-identity">
          <OrganizationMark name={organization.name} logo={organization.logo} size={40} />
          <h1 className="new-thread-question">{organization.name}</h1>
        </div>
        <p className="organization-membership-detail">{lost ? "You no longer have access to this project." : "An admin needs to give you access to a project."}</p>
        <Button onClick={onPeople}>People</Button>
      </div>
    </div>
  );
}
