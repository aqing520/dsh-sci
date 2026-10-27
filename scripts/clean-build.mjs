import { lstat, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Only the project's generated output is removed, regardless of the caller's cwd.
const output = fileURLToPath(new URL("../dist/", import.meta.url));
const info = await lstat(output).catch((error) => {
  if (error.code === "ENOENT") return undefined;
  throw error;
});
if (info?.isSymbolicLink()) throw new Error("Refusing to clean a linked dist directory");
await rm(output, { recursive: true, force: true });
