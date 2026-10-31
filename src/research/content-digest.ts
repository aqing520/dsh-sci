import { createHash } from "node:crypto";

/** JSON object order is not evidence; array order remains significant. */
export function contentDigest(value: unknown): string {
  const canonical = (item: any): any => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") return Object.fromEntries(Object.keys(item).sort().filter((key) => item[key] !== undefined).map((key) => [key, canonical(item[key])]));
    return item;
  };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
