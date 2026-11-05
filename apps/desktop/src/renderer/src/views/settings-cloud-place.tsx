import { BRAIN_REGIONS, type BrainRegion, type CloudBrainPlace, type CloudService } from "@openorc/protocol";
import { Select } from "../components/ui";

export const SERVICE_NAMES: Record<CloudService, string> = { vercel: "Vercel", agent37: "Agent37" };

export const regionName = (region: BrainRegion) => `${BRAIN_REGIONS[region]} · ${region}`;

/** Where a brain runs, in a few words: "Vercel · Frankfurt", or the service alone on Agent37, which has one region. */
export const placeWords = ({ service, region }: CloudBrainPlace) => (region ? `${SERVICE_NAMES[service]} · ${BRAIN_REGIONS[region]}` : SERVICE_NAMES[service]);

/** Every region Vercel runs sandboxes in, by city: where the brain is set up, and where new sandboxes run. */
export function RegionSelect({ label, value, disabled, onChange }: { label?: string; value: BrainRegion; disabled: boolean; onChange: (region: BrainRegion) => void }) {
  return (
    <Select aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as BrainRegion)}>
      {(Object.keys(BRAIN_REGIONS) as BrainRegion[]).map((option) => (
        <option key={option} value={option}>
          {regionName(option)}
        </option>
      ))}
    </Select>
  );
}
