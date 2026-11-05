import type { ReactNode } from "react";

/** A masked view draws its mask's shape filled by its children; in tests it shows the mask, the part a reader sees. */
export default function MaskedView({ maskElement }: { maskElement: ReactNode; children?: ReactNode }) {
  return <div data-masked="">{maskElement}</div>;
}
