import { Redirect } from "expo-router";

/** A path no screen has goes Home. */
export default function NotFound() {
  return <Redirect href="/" />;
}
