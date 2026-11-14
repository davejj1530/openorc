import { People } from "./icons";
import "./Organization.css";

/** Organization identity uses its safe raster, then its initial. The file field starts with a neutral people mark. */
export function OrganizationMark({ name, logo, size = 20 }: { name?: string; logo: string | null; size?: number }) {
  const placeholder = name ? [...name.trim()][0]?.toUpperCase() : <People size={size / 2} />;
  return (
    <span className="organization-mark" style={{ width: size, height: size, borderRadius: size / 4, fontSize: size / 2 }} aria-hidden="true">
      {logo ? <img src={logo} alt="" /> : placeholder}
    </span>
  );
}
