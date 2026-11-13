import { initials } from "@openorc/client";
import { cn } from "../lib/cn";

/** A person's face: their picture, else their initials on a quiet fill. Decorative: their name is always beside it. */
export function AccountFace({ name, image, className }: { name: string; image: string | null; className?: string }) {
  return image ? (
    <img src={image} alt="" aria-hidden="true" className={cn("account-face", className)} />
  ) : (
    <span aria-hidden="true" className={cn("account-face", className)}>
      {initials(name)}
    </span>
  );
}
