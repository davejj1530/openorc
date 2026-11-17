/** A picture bundled with the app, as Metro hands it to an Image: an asset id. */
declare module "*.webp" {
  import type { ImageSourcePropType } from "react-native";

  const source: ImageSourcePropType;
  export default source;
}
