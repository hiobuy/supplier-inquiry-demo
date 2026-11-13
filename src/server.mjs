// Local Node host for the shared Inquiry Demo handler. No production secrets are inferred.
import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT_DIR, loadWebhookSecrets } from "./config.mjs";
import { Store } from "./store.mjs";
import { createDemoHandler } from "./handler.mjs";
export { sanitizeAttachment, sanitizeMessage } from "./handler.mjs";

export function createDemoServer({ config, fetchImpl = globalThis.fetch, now = () => Date.now(), keyTtlMs,
  publicDir = path.join(ROOT_DIR, "public"), demoDefaults = null }) {
  const webhookSecrets = config.webhookConfigFile ? loadWebhookSecrets(config.webhookConfigFile) : new Map();
  const store = new Store(config.dataDir, { now });
  const assets = new Map();
  for (const [route,file,type] of [["/","index.html","text/html; charset=utf-8"],["/app.js","app.js","text/javascript; charset=utf-8"],["/app.css","app.css","text/css; charset=utf-8"]]) {
    try { assets.set(route, { body: readFileSync(path.join(publicDir,file)), type }); } catch {}
  }
  const core = createDemoHandler({ config, fetchImpl, now, keyTtlMs, store, assets, webhookSecrets, demoDefaults });
  let server = null, purgeTimer = null;
  return {
    store, vault: core.vault,
    webhookConfiguredApps: core.webhookConfiguredApps,
    get port() { return server?.address()?.port ?? null; },
    async start() {
      server = http.createServer({ maxHeaderSize: 16*1024, requestTimeout:300000, headersTimeout:20000 }, core.onRequest);
      await new Promise((resolve,reject) => { server.once("error",reject); server.listen(config.port,"127.0.0.1",resolve); });
      const port = server.address().port; core.setLocalPort(port); core.vault.startPurge();
      purgeTimer = setInterval(() => { try { store.purgeSessions(); } catch {} },3600000); purgeTimer.unref();
      return port;
    },
    async close() {
      core.close(); if (purgeTimer) clearInterval(purgeTimer);
      if (server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
      store.close();
    },
  };
}
