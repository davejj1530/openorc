import { View } from "react-native";
import { useLinkState } from "../client";
import { useOwnCloud } from "../cloud/use-own-cloud";
import { useLinkWords } from "../connection/use-link-words";
import { Text } from "../ui/Text";

/**
 * A side panel screen's title: the tool's name, or the file's, over a faint line. While the phone is not connected,
 * the connection's state takes the line, as the thread's title does; not for a panel that reads OpenOrc Cloud through
 * the phone's own session (`fromCloud`), which the Mac's link says nothing of.
 */
export function PanelTitle({ title, line, fromCloud = false }: { title: string; line: string | null; fromCloud?: boolean }) {
  const link = useLinkWords(useLinkState());
  const ownCloud = useOwnCloud();
  const away = !(fromCloud && ownCloud) && link.tone !== "ok" && link.status ? link.status : null;
  const shown = away ?? line;
  return (
    <View accessible accessibilityRole="header" accessibilityLabel={[title, shown].filter(Boolean).join(", ")} className="max-w-60 items-center">
      <Text numberOfLines={1} ellipsizeMode="middle" className="text-md leading-5">
        {title}
      </Text>
      {shown ? (
        <Text numberOfLines={1} className="text-xs leading-4 text-ink-4">
          {shown}
        </Text>
      ) : null}
    </View>
  );
}
