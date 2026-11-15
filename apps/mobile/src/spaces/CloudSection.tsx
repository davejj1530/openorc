import { View } from "react-native";
import { useRpc } from "../client";
import type { LinkState } from "../connection/manager";
import { Cloud } from "../generated/icons";
import { Card, RowLines, rowClass, Section } from "../settings/parts";
import { cloudRow } from "./cloud-words";
import { useSpaces } from "./use-spaces";

/**
 * The OpenOrc account behind the cloud threads Home lists, under the Mac in the connection sheet: the person signed in
 * on that Mac, which the phone reads OpenOrc Cloud through. Nothing for a Mac that shares none.
 */
export function CloudSection({ state }: { state: LinkState }) {
  const account = useSpaces();
  const person = useRpc("account.person", {}, { enabled: account.state === "ready" }).data;
  if (state.kind === "unpaired") return null;
  const row = cloudRow(account, person?.name, state.mac.name);
  if (!row) return null;
  return (
    <Section title="OpenOrc Cloud">
      <Card>
        <View accessible accessibilityLabel={[row.label, row.detail].filter(Boolean).join(", ")} className={rowClass}>
          <RowLines lead={<Cloud size={16} className="text-ink-4" />} label={row.label} detail={row.detail} />
        </View>
      </Card>
    </Section>
  );
}
