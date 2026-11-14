import { z } from "zod";
import { checkedLogo } from "./stand-in-logo.js";
import { topLevelDomains } from "./stand-in-domains.js";

const invisible = /[\p{Cc}\p{Cf}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2800\u3164\uFE00-\uFE0F\uFFA0\u{E0100}-\u{E01EF}]/u;
const scheme = /:\/\/|(?:^|[^\p{L}\p{N}])www\./iu;
const dotted = /[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const holdsWebAddress = (text: string) =>
  scheme.test(text) ||
  [...text.matchAll(dotted)].some(([word]) =>
    word
      .split(".")
      .slice(1)
      .some((label) => topLevelDomains.has(label.toLowerCase())),
  );
const name = z
  .string()
  .transform((value) => value.normalize("NFKC").replace(/\s+/g, " ").trim())
  .pipe(
    z
      .string()
      .min(1, "Give your name.")
      .max(80, "Keep the name under 80 characters.")
      .refine((value) => !invisible.test(value), "That name has characters that don't show. Type it again.")
      .refine((value) => !holdsWebAddress(value), "Use a name, not a link or a web address."),
  );
const image = z
  .string()
  .max(64_000, "That picture is too big. Pick a smaller one.")
  .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/, "Pick a PNG, JPEG or WebP picture.");
const patch = z.object({ name: name.optional(), image: image.nullable().optional() }).refine((value) => value.name !== undefined || value.image !== undefined, "Say what to change.");
type Person = { name: string; image: string | null };

/** Both fields validate before the saved person replaces the existing record. */
export async function profileRoute(body: Record<string, unknown>, who: string, current: Person, save: (person: Person) => void) {
  const parsed = patch.safeParse(body);
  if (!parsed.success) return { status: 400, body: { message: parsed.error.issues[0]!.message } };
  const picture = parsed.data.image === undefined ? { logo: current.image } : await checkedLogo(parsed.data.image);
  if ("error" in picture) return { status: 400, body: { message: picture.error } };
  const person = { name: parsed.data.name ?? current.name, image: picture.logo };
  save(person);
  return { status: 200, body: { id: `user-${who}`, email: who, ...person } };
}
