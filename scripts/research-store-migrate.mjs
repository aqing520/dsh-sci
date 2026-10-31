import { migrateResearchStore } from "../dist/src/research/migration.js";

const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  const name = args[i], value = args[i + 1];
  if (!["--source", "--target"].includes(name) || Object.hasOwn(options, name) || !value || value.startsWith("--")) throw new Error("Usage: research-store-migrate.mjs --source <closed-research-root> --target <new-research-root>");
  options[name] = value;
}
if (!options["--source"] || !options["--target"]) throw new Error("Both --source and --target are required; close the application before migration");
try { console.log(JSON.stringify(await migrateResearchStore(options["--source"], options["--target"]), null, 2)); }
catch (error) { console.error(JSON.stringify({ ok: false, code: error.code ?? "DSH_SCI_MIGRATION_FAILED", message: "Migration failed. The source remains unchanged; retain the migration directory for recovery." })); process.exitCode = 1; }
