import { readFile } from "node:fs/promises";
import { restoreAuditBundle } from "../dist/src/recovery.js";

const [bundleFile, targetRoot] = process.argv.slice(2);
if (!bundleFile || !targetRoot) throw new Error("Usage: npm run recovery:restore -- <audit-bundle.json> <empty-capture-root>");
const result = await restoreAuditBundle(await readFile(bundleFile, "utf8"), targetRoot);
console.log(JSON.stringify(result, null, 2));
