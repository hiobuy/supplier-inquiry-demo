// Operator defaults remain server-only; no API key is shipped to the browser.
import { loadConfig } from "./config.mjs";
import { loadFixedDemoDefaults } from "./defaults.mjs";
import { ROOT_DIR } from "./config.mjs";
import path from "node:path";
import { createDemoServer } from "./server.mjs";

const config = loadConfig();
const demoDefaults = loadFixedDemoDefaults(
  process.env.INQUIRY_DEMO_DEFAULTS || path.join(ROOT_DIR, ".dev.vars"),
);
const app = createDemoServer({ config, demoDefaults });
const port = await app.start();
process.stdout.write(
  `Inquiry Demo listening on http://localhost:${port} (gateway ${config.gatewayOrigin})\n`,
);

let closing = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    await app.close();
    process.exit(0);
  });
}
