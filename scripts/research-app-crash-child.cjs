// Isolated test entry point; production main contains no test control channels.
const { app } = require("electron");
const path = require("node:path");
const argsStart = process.argv.indexOf(__filename);
const [phase, root] = process.argv.slice(argsStart >= 0 ? argsStart + 1 : 2);
app.setPath("userData", path.join(root, "user-data"));
app.on("browser-window-created", (_event, window) => window.hide());
app.whenReady().then(async () => {
  await import("./research-app-crash-child.mjs");
}).catch((error) => { console.error(error.message); app.exit(1); });
