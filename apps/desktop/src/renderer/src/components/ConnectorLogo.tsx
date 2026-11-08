import { useState } from "react";
import { logoLetter } from "../lib/connector-presentation";
import "./ConnectorLogo.css";

/** A connector's image, or the first letter of its name on a tile when it has none or it does not load. */
export function ConnectorLogo({ title, logo, size = 20 }: { title: string; logo: string | null; size?: number }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (logo && failed !== logo) return <img className="connector-logo" src={logo} alt="" width={size} height={size} draggable={false} onError={() => setFailed(logo)} />;
  return (
    <span className="connector-logo connector-logo-letter" style={{ width: size, height: size, fontSize: Math.round(size * 0.55) }} aria-hidden="true">
      {logoLetter(title)}
    </span>
  );
}
