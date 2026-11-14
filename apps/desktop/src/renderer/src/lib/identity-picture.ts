/** Decode, crop and re-encode locally so neither metadata nor the picked file crosses the account boundary. */
export async function identityPicture(file: File): Promise<string> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("Pick a PNG, JPEG or WebP picture.");
  let picture: ImageBitmap;
  try {
    picture = await createImageBitmap(file);
  } catch {
    throw new Error("That picture couldn't be read. Pick another PNG, JPEG or WebP.");
  }
  try {
    if (!picture.width || !picture.height || picture.width * picture.height > 64_000_000) throw new Error("That picture is too big. Pick a smaller one.");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 128;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("That picture couldn't be read. Pick another PNG, JPEG or WebP.");
    const side = Math.min(picture.width, picture.height);
    context.drawImage(picture, (picture.width - side) / 2, (picture.height - side) / 2, side, side, 0, 0, 128, 128);
    const logo = canvas.toDataURL("image/webp", 0.9);
    if (logo.length > 64_000) throw new Error("That picture is too big. Pick a smaller one.");
    return logo;
  } finally {
    picture.close();
  }
}
