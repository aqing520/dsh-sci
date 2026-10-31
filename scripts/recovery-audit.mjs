import os from "node:os";
import path from "node:path";
import { auditCaptureRoot } from "../dist/src/recovery.js";

const configuredRoot = process.env.DSH_SCI_CAPTURE_ROOT;
const requestedRoot = process.argv[2] ?? configuredRoot ?? path.join(process.env.APPDATA ?? os.homedir(), "dsh-sci", "capture");
const result = await auditCaptureRoot(requestedRoot);
console.log(JSON.stringify(result, null, 2));
if (!result.healthy) process.exitCode = 1;
