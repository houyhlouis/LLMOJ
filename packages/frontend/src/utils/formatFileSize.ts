export default function formatFileSize(size: number | null | undefined, precision: number) {
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) return "—";
  const units = ["K", "M", "G", "T"];

  let unit = "B";
  for (const currUnit of units) {
    if (size > 1024) {
      size /= 1024;
      unit = currUnit;
    }
  }

  const fixed = size === Math.round(size) ? size.toString() : size.toFixed(precision);
  return fixed + " " + unit;
}
