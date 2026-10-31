import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseMetadataJson } from "../metadata-crypto.js";

export const researchStoreFormatFile = "store-format.json";
export interface ResearchStoreFormat {
  schema: "dsh-sci.research-store-format.v1";
  formatVersion: 1;
  minimumReaderVersion: 1;
  state: "migrating" | "ready";
  migrationId: string;
}

/** An absent marker means the legacy layout. Never infer compatibility from an unknown marker. */
export async function assertCompatibleResearchStore(root: string, passphrase?: string, migrationId?: string): Promise<void> {
  let value: ResearchStoreFormat;
  try { value = parseMetadataJson<ResearchStoreFormat>(await readFile(path.join(root, researchStoreFormatFile), "utf8"), passphrase); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!value || value.schema !== "dsh-sci.research-store-format.v1" || value.formatVersion !== 1 || value.minimumReaderVersion !== 1 || !["migrating", "ready"].includes(value.state) || typeof value.migrationId !== "string" || !value.migrationId) throw new Error("Research store format is incompatible; use a compatible application or restore the pre-migration backup for downgrade");
  if (value.state !== "ready" && migrationId !== value.migrationId) throw new Error("Research data migration is incomplete; resume the offline migration before opening this store");
}
