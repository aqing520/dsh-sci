const { app } = require("electron");
app.whenReady().then(() => import("./research-code-review-workspace-smoke.mjs")).catch((error) => { console.error(error); app.exit(1); });
