import sharp from "sharp";

// Fixed normalized regions are identical across columns, including differing resolutions.
export const detailRegions = [
  { x: 0, y: 0 }, { x: 0.75, y: 0 }, { x: 0.375, y: 0.375 },
  { x: 0, y: 0.75 }, { x: 0.75, y: 0.75 },
] as const;

export async function detailSheet(paths: string[]): Promise<Buffer> {
  if (paths.length < 1 || paths.length > 4) throw new Error("detail_sheet_invalid_columns");
  const size = 320;
  const cells: sharp.OverlayOptions[] = [];
  for (const [column, path] of paths.entries()) {
    const { data, info } = await sharp(path).rotate().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
    const width = Math.max(1, Math.floor(info.width / 4));
    const height = Math.max(1, Math.floor(info.height / 4));
    for (const [row, region] of detailRegions.entries()) {
      const input = await sharp(data, { raw: info }).extract({
        left: Math.min(info.width - width, Math.floor(info.width * region.x)),
        top: Math.min(info.height - height, Math.floor(info.height * region.y)), width, height,
      }).resize(size, size, { fit: "contain", background: "#808080" }).png().toBuffer();
      cells.push({ input, left: column * size, top: row * size });
    }
  }
  return sharp({ create: { width: size * paths.length, height: size * detailRegions.length, channels: 3, background: "#808080" } })
    .composite(cells).png().toBuffer();
}

export async function detailContent(images: Array<{ label: string; path: string }>) {
  const bytes = await detailSheet(images.map((image) => image.path));
  return [
    { type: "input_text", text: `Matched detail sheet. Columns left to right: ${images.map((image) => image.label).join(", ")}. Rows top to bottom: top-left, top-right, center, bottom-left, bottom-right. Each crop covers 25% of image width/height, resized without stretching. Gray padding is not image content. Inspect repeated synthetic texture, loss of natural variation and edge damage. These samples are not exhaustive; composition changes can move objects between regions.` },
    { type: "input_image", image_url: `data:image/png;base64,${bytes.toString("base64")}`, detail: "high" },
  ];
}
