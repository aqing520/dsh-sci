const { app } = require("electron");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { realpathSync } = require("node:fs");
const index = process.argv.indexOf("--case");
if (index < 0 || !process.argv[index + 1]) {
  console.error("Usage: electron scripts/research-case-workspace.cjs --case <validation-case> [--review]");
  app.exit(2);
} else {
  const casePath = realpathSync(path.resolve(process.argv[index + 1]));
  const key = createHash("sha256").update(process.platform === "win32" ? casePath.toLowerCase() : casePath).digest("hex").slice(0, 24);
  app.setPath("userData", path.join(os.tmpdir(), "dsh-sci-case-review", key));
  if (!app.requestSingleInstanceLock()) { console.error("This case already has an open review window"); app.exit(2); }
  else app.whenReady().then(() => import("./research-case-workspace.mjs")).catch((error) => { console.error(error); app.exit(1); });
}
